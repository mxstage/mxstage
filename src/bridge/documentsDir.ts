// 利用者の「ドキュメント」フォルダの場所。接続先の辞書と Skill の既定の置き場所（ドキュメント\MX Stage\<接続先の名前>）に使う。
// - Windows は「ドキュメント」を別の場所（OneDrive の中など）へ移せるので、.NET の GetFolderPath で読む
//   （reg.exe の出力は OEM のコードページなので、日本語の利用者名が化ける）。読めなければ <ホーム>\Documents。
// - 試験・手で確かめるときは環境変数 MXSTAGE_DOCUMENTS_DIR で差し替える（利用者のドキュメントに書かないため）。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const GET_DOCUMENTS = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')";

let cached: string | null = null;

/** PowerShell の出力（1 行）からフォルダの場所を読む */
export function parseFolderOutput(output: string): string | null {
  const path = output.replace(/^﻿/, "").trim();
  return path !== "" && !path.includes("\n") && isAbsolute(path) ? path : null;
}

export function documentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MXSTAGE_DOCUMENTS_DIR;
  if (typeof override === "string" && isAbsolute(override)) return override;
  if (cached !== null) return cached;
  let found: string | null = null;
  if (process.platform === "win32") {
    try {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", GET_DOCUMENTS], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      if (r.status === 0 && typeof r.stdout === "string") found = parseFolderOutput(r.stdout);
    } catch {
      found = null;
    }
  }
  cached = found ?? join(homedir(), "Documents");
  return cached;
}
