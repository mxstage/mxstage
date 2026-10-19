// 作業画面と AI アシスタントの窓を、画面に左右に並べる（作業画面の上部バーのボタン。Windows だけ）。
// - 作業画面の窓は、作業画面が一時的に付けた印（題名の「[arrange <印>]」）で見つける（ブラウザ・インストールしたアプリのどちらでも）。
// - AI アシスタントの窓は、知っているアプリ（Codex・Claude・VS Code 系・Cursor・ChatGPT・ターミナルなど）の窓のうち、
//   一番手前にあるもの（直前まで使っていた窓）にする。作業画面が AI アシスタントの中で開いていれば並べない。
// - 作業画面のある画面の作業領域（タスクバーを除く）に、左に AI アシスタント（38%）、右に作業画面を置く。最大化・最小化は解く。
//   Windows 10 以降の窓の見えない縁（影の分）を差し引いて、2 つの窓がすき間なく並ぶようにする。
// 窓の題名は返さない（ほかのアプリの中身が題名に出ることがあるため）。返すのはアプリの種類だけ。

import { spawn } from "node:child_process";

export type ArrangeResult =
  | { ok: true; assistant: string }
  | { ok: false; reason: "unsupported" | "no_work_window" | "no_assistant" | "inside_assistant" | "failed"; detail?: string };

export const ARRANGE_TOKEN_RE = /^[a-z0-9]{8,32}$/;
/** AI アシスタントの窓の幅（作業領域に対する割合） */
export const ASSISTANT_RATIO = 0.38;

/** AI アシスタントのアプリ（プロセス名を小文字で、.exe を除いて）→ 返す名前 */
export const ASSISTANT_PROCESSES: Readonly<Record<string, string>> = {
  codex: "Codex",
  claude: "Claude",
  chatgpt: "ChatGPT",
  code: "VS Code",
  "code - insiders": "VS Code",
  cursor: "Cursor",
  windsurf: "Windsurf",
  bob: "IBM Bob",
  "ibm bob": "IBM Bob",
  kiro: "Kiro",
  windowsterminal: "Terminal",
  wezterm: "Terminal",
  "wezterm-gui": "Terminal",
  alacritty: "Terminal",
};

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class MxArrange {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);

  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Proc(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { return ""; }
  }
  // 画面に出ている、ほかの窓に属さない普通の窓（手前から順に）
  public static List<IntPtr> TopWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0 || Title(h).Length == 0) return true;
      list.Add(h); return true;
    }, IntPtr.Zero);
    return list;
  }
  // 見えない縁を差し引いて、見た目の枠が (x, y, w, h) になるように置く
  public static void Place(IntPtr h, int x, int y, int w, int hgt) {
    if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9);
    RECT wr, fr; GetWindowRect(h, out wr);
    int l = 0, t = 0, r = 0, b = 0;
    if (DwmGetWindowAttribute(h, 9, out fr, 16) == 0) { l = fr.L - wr.L; t = fr.T - wr.T; r = wr.R - fr.R; b = wr.B - fr.B; }
    SetWindowPos(h, IntPtr.Zero, x - l, y - t, w + l + r, hgt + t + b, 0x0004 | 0x0010 | 0x0040);
  }
}
'@
[void][MxArrange]::SetProcessDpiAwarenessContext([IntPtr](-4))
$token = $env:MXSTAGE_ARRANGE_TOKEN
$names = $env:MXSTAGE_ARRANGE_APPS -split ','
$ratio = [double]$env:MXSTAGE_ARRANGE_RATIO
$work = [IntPtr]::Zero
$assistant = [IntPtr]::Zero
$assistantProc = ''
for ($i = 0; $i -lt 20 -and $work -eq [IntPtr]::Zero; $i++) {
  foreach ($h in [MxArrange]::TopWindows()) { if ([MxArrange]::Title($h).Contains("[arrange $token]")) { $work = $h; break } }
  if ($work -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
}
if ($work -eq [IntPtr]::Zero) { '{"ok":false,"reason":"no_work_window"}'; exit 0 }
$workProc = [MxArrange]::Proc($work)
if ($names -contains $workProc) { '{"ok":false,"reason":"inside_assistant"}'; exit 0 }
foreach ($h in [MxArrange]::TopWindows()) {
  if ($h -eq $work) { continue }
  $p = [MxArrange]::Proc($h)
  if ($names -contains $p) { $assistant = $h; $assistantProc = $p; break }
}
if ($assistant -eq [IntPtr]::Zero) { '{"ok":false,"reason":"no_assistant"}'; exit 0 }
$mi = New-Object MxArrange+MONITORINFO
$mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
[void][MxArrange]::GetMonitorInfo([MxArrange]::MonitorFromWindow($work, 2), [ref]$mi)
$a = $mi.rcWork
$width = $a.R - $a.L
$height = $a.B - $a.T
$left = [int][Math]::Round($width * $ratio)
[MxArrange]::Place($assistant, $a.L, $a.T, $left, $height)
[MxArrange]::Place($work, $a.L + $left, $a.T, $width - $left, $height)
'{"ok":true,"process":"' + $assistantProc + '"}'
`;

/** PowerShell の出力（最後の JSON の行）を結果にする */
export function parseArrangeOutput(stdout: string): ArrangeResult {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (line === undefined) return { ok: false, reason: "failed", detail: "no result" };
  try {
    const v = JSON.parse(line) as { ok?: unknown; reason?: unknown; process?: unknown };
    if (v.ok === true) return { ok: true, assistant: ASSISTANT_PROCESSES[String(v.process)] ?? "AI" };
    const reason = v.reason;
    if (reason === "no_work_window" || reason === "no_assistant" || reason === "inside_assistant") return { ok: false, reason };
    return { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed", detail: "unreadable result" };
  }
}

export interface ArrangeOptions {
  platform?: NodeJS.Platform;
  /** 試験で差し替える（PowerShell を動かす代わり） */
  run?: (script: string, env: Record<string, string>) => Promise<string>;
}

function runPowerShell(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((done, fail) => {
    // 複数行の台本は標準入力では読み違えるので、-EncodedCommand（UTF-16LE の Base64）で渡す
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(out);
      else fail(new Error(err.trim().slice(0, 300) || `exit ${code}`));
    });
    child.stdin.end();
  });
}

/** 印を題名に付けた作業画面の窓と、手前の AI アシスタントの窓を左右に並べる */
export async function arrangeWindows(token: string, opts: ArrangeOptions = {}): Promise<ArrangeResult> {
  if ((opts.platform ?? process.platform) !== "win32") return { ok: false, reason: "unsupported" };
  if (!ARRANGE_TOKEN_RE.test(token)) return { ok: false, reason: "failed", detail: "bad token" };
  const env = { MXSTAGE_ARRANGE_TOKEN: token, MXSTAGE_ARRANGE_APPS: Object.keys(ASSISTANT_PROCESSES).join(","), MXSTAGE_ARRANGE_RATIO: String(ASSISTANT_RATIO) };
  try {
    return parseArrangeOutput(await (opts.run ?? runPowerShell)(SCRIPT, env));
  } catch (e) {
    return { ok: false, reason: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
}
