// フォルダをエクスプローラー（Windows）・Finder（macOS）・ファイルの画面（Linux）で開く。開けなくても止めない。

import { spawn } from "node:child_process";

export function openFolder(path: string): void {
  const command =
    process.platform === "win32"
      ? { file: "explorer.exe", args: [path] }
      : process.platform === "darwin"
        ? { file: "open", args: [path] }
        : { file: "xdg-open", args: [path] };
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // 開けなくても、画面に場所を出している
  }
}
