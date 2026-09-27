// 橋渡しの記録がファイルにも残ること（Claude が終了した後の調査に使う）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeLogger, LOG_FILE_NAME, LOG_MAX_BYTES } from "../../src/bridge/logFile.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mxstudio-log-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createBridgeLogger", () => {
  it("stderr と同じ内容を、時刻を付けてファイルにも書く", () => {
    const dir = tempDir();
    const out: string[] = [];
    const log = createBridgeLogger({ stateDir: join(dir, "state"), write: (t) => out.push(t), now: () => new Date("2026-09-18T01:02:03.000Z") });
    log("mxstudio bridge listening on http://127.0.0.1:8788");
    log("mxstudio bridge stopping");
    expect(out).toEqual(["mxstudio bridge listening on http://127.0.0.1:8788\n", "mxstudio bridge stopping\n"]);
    const text = readFileSync(join(dir, "state", LOG_FILE_NAME), "utf8");
    expect(text).toBe("2026-09-18T01:02:03.000Z mxstudio bridge listening on http://127.0.0.1:8788\n2026-09-18T01:02:03.000Z mxstudio bridge stopping\n");
  });

  it("大きくなったら 1 つ前に送る（際限なく増やさない）", () => {
    const dir = tempDir();
    const path = join(dir, LOG_FILE_NAME);
    writeFileSync(path, "x".repeat(LOG_MAX_BYTES), "utf8");
    const log = createBridgeLogger({ stateDir: dir, write: () => {} });
    log("新しい行");
    expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(LOG_MAX_BYTES);
    expect(readFileSync(path, "utf8")).toContain("新しい行");
  });

  it("ファイルに書けなくても橋渡しは動かし続ける（画面への出力は続く）", () => {
    const dir = tempDir();
    // フォルダを作れない場所（ファイルの下）を指す
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "", "utf8");
    const out: string[] = [];
    const log = createBridgeLogger({ stateDir: join(blocked, "state"), write: (t) => out.push(t) });
    expect(() => log("続ける")).not.toThrow();
    expect(() => log("まだ続ける")).not.toThrow();
    expect(out).toEqual(["続ける\n", "まだ続ける\n"]);
  });
});
