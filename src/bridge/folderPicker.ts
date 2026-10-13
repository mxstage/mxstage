// フォルダを選ぶ画面（OS の標準の画面）を開く。共有フォルダを選ぶときに作業画面から頼まれる。
// 橋渡しはこの PC の利用者として動いているので、画面はこの PC のデスクトップに出る。ブラウザはフォルダの場所を教えてくれないため、ここで選ぶ。
// - Windows: PowerShell の FolderBrowserDialog（前面に出す）
// - macOS: osascript の choose folder
// - Linux: zenity（無ければ使えない）
// 選んだ場所を返す。やめたら null。

import { spawn } from "node:child_process";
import { platform } from "node:os";

/** 選ぶ画面を開いたままにできる上限 */
const PICK_TIMEOUT_MS = 5 * 60 * 1000;

export type PickResult = { ok: true; path: string | null } | { ok: false; reason: "unsupported" | "failed" | "busy" };

let picking = false;

function windowsScript(title: string): string {
  // 文字化けしないよう UTF-8 で返す。前面に出すため、見えない最前面のフォームを親にする
  const t = title.replace(/'/g, "''");
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description = '${t}'`,
    "$d.ShowNewFolderButton = $true",
    "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
    "$owner.Dispose()",
  ].join("; ");
}

function command(title: string): { cmd: string; args: string[] } | null {
  const p = platform();
  if (p === "win32") return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", windowsScript(title)] };
  if (p === "darwin") return { cmd: "osascript", args: ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`] };
  if (p === "linux") return { cmd: "zenity", args: ["--file-selection", "--directory", `--title=${title}`] };
  return null;
}

export async function pickFolder(title: string): Promise<PickResult> {
  if (picking) return { ok: false, reason: "busy" };
  const c = command(title);
  if (c === null) return { ok: false, reason: "unsupported" };
  picking = true;
  try {
    return await new Promise<PickResult>((resolveResult) => {
      let out = "";
      let done = false;
      const finish = (r: PickResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolveResult(r);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(c.cmd, c.args, { windowsHide: false, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        finish({ ok: false, reason: "unsupported" });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: true, path: null });
      }, PICK_TIMEOUT_MS);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        out += d;
      });
      child.on("error", () => finish({ ok: false, reason: "unsupported" }));
      child.on("close", (code) => {
        const path = out.trim().replace(/[\\/]$/, "");
        // osascript と zenity はやめると 1 で終わる
        if (path !== "") finish({ ok: true, path });
        else finish(code === 0 || code === 1 ? { ok: true, path: null } : { ok: false, reason: "failed" });
      });
    });
  } finally {
    picking = false;
  }
}
