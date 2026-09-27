// 待ち受けのふるまい（ポートの衝突でずらさないことと、127.0.0.1 以外で待たないこと）。

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isPortInUseError } from "../../src/bridge/server.ts";
import { startTestBridge, stopAll } from "./support.ts";

afterEach(async () => {
  await stopAll();
});

/**
 * ポートを 1 つ占有する。19000 番台から選ぶ（利用者が橋渡しを動かしているかもしれない 8788 と、
 * 並行して動く他の試験が OS から割り当てられる動的ポート（49152 以上）を避ける）。
 */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const start = 19_000 + Math.floor(Math.random() * 600);
  for (let port = start; port < start + 400; port += 2) {
    const probe = createServer();
    try {
      await new Promise<void>((done, failed) => {
        probe.once("error", failed);
        probe.listen(port, "127.0.0.1", () => done());
      });
    } catch {
      continue;
    }
    return { port, release: () => new Promise<void>((done) => probe.close(() => done())) };
  }
  throw new Error("占有できるポートが見つかりませんでした");
}

describe("ポート", () => {
  it("使用中ならずらさずに失敗する（ずれると作業タブの URL と Hub が分かれる）", async () => {
    const taken = await occupyPort();
    try {
      let caught: unknown = null;
      try {
        await startTestBridge({ port: taken.port });
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(isPortInUseError(caught)).toBe(true);
    } finally {
      await taken.release();
    }
  });

  it("空いていれば指定したポートで待ち受ける", async () => {
    const taken = await occupyPort();
    await taken.release();
    const bridge = await startTestBridge({ port: taken.port });
    expect(bridge.port).toBe(taken.port);
    expect(bridge.origin).toBe(`http://127.0.0.1:${taken.port}`);
  });

  it("127.0.0.1 だけで待ち受ける", async () => {
    const bridge = await startTestBridge();
    const address = bridge.server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
  });
});
