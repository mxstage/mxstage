import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeCoordinator } from "../../src/bridge/coordinator.ts";
import { LEGACY_MIGRATED_MARKER, LEGACY_STATE_DIR_NAME, PUBLISH_TERMS_FILE, legacyStateDir, legacyUserSkillsDir, migrateLegacyFiles } from "../../src/bridge/legacy.ts";
import { LEGACY_BRIDGE_NAME, LEGACY_PEER_HEALTH_PATH, probeBridgeHealth } from "../../src/bridge/peer.ts";
import { BridgeKeyStore } from "../../src/bridge/bridgeKey.ts";

const temps: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mxstage-legacy-"));
  temps.push(d);
  return d;
}

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), body, "utf8");
}

describe("改名前（~/.config/mxstudio）の利用者の Skill と語の一覧を写す", () => {
  it("新しい置き場所に無いものだけを写し、あるものは書き換えない。古い置き場所は消さない。写し終えたら印を書き、2 回目からは何もしない", async () => {
    const home = await tempHome();
    const legacy = legacyUserSkillsDir(home);
    expect(legacy).toBe(join(home, ".config", LEGACY_STATE_DIR_NAME, "skills"));
    await writeSkill(legacy, "wo-date-update", "old-a");
    await writeSkill(legacy, "asset-relink", "old-b");
    await writeFile(join(legacyStateDir(home), PUBLISH_TERMS_FILE), "term-a\n", "utf8");
    const stateDir = join(home, ".config", "mxstage");
    await writeSkill(join(stateDir, "skills"), "asset-relink", "new-b");
    const logs: string[] = [];

    const first = migrateLegacyFiles({ stateDir, enabled: true, home, log: (l) => logs.push(l) });
    expect(first).toEqual({ copied: ["wo-date-update", PUBLISH_TERMS_FILE], failed: [] });
    expect(await readFile(join(stateDir, "skills", "wo-date-update", "SKILL.md"), "utf8")).toBe("old-a");
    expect(await readFile(join(stateDir, "skills", "asset-relink", "SKILL.md"), "utf8")).toBe("new-b");
    expect(await readFile(join(stateDir, PUBLISH_TERMS_FILE), "utf8")).toBe("term-a\n");
    expect(await readFile(join(legacy, "wo-date-update", "SKILL.md"), "utf8")).toBe("old-a");
    expect(logs.join("\n")).toContain("wo-date-update");
    const marker = JSON.parse(await readFile(join(stateDir, LEGACY_MIGRATED_MARKER), "utf8"));
    expect(marker.copied).toEqual(["wo-date-update", PUBLISH_TERMS_FILE]);

    // 写したあとに利用者が消したものは、次の起動で写し直さない
    await rm(join(stateDir, "skills", "wo-date-update"), { recursive: true, force: true });
    expect(migrateLegacyFiles({ stateDir, enabled: true, home })).toEqual({ copied: [], failed: [] });
    await expect(stat(join(stateDir, "skills", "wo-date-update"))).rejects.toThrow();
  });

  it("enabled: false（状態フォルダを差し替えているとき）と、古い置き場所が無いときは何もしない（印も書かない）", async () => {
    const home = await tempHome();
    await writeSkill(legacyUserSkillsDir(home), "a", "x");
    const stateDir = join(home, ".config", "mxstage");
    expect(migrateLegacyFiles({ stateDir, enabled: false, home })).toEqual({ copied: [], failed: [] });
    await expect(stat(join(stateDir, LEGACY_MIGRATED_MARKER))).rejects.toThrow();
    const empty = await tempHome();
    const emptyState = join(empty, ".config", "mxstage");
    expect(migrateLegacyFiles({ stateDir: emptyState, enabled: true, home: empty })).toEqual({ copied: [], failed: [] });
    await expect(stat(join(emptyState, LEGACY_MIGRATED_MARKER))).rejects.toThrow();
  });

  it("写し終えた印の名前は、導入（scripts/setup-local.mjs）と同じ", async () => {
    const setup = await readFile(join(import.meta.dirname, "..", "..", "scripts", "setup-local.mjs"), "utf8");
    expect(setup).toContain(`migratedMarker: "${LEGACY_MIGRATED_MARKER}"`);
    expect(setup).toContain(`publishTerms: "${PUBLISH_TERMS_FILE}"`);
    expect(setup).toContain(`stateDirName: "${LEGACY_STATE_DIR_NAME}"`);
  });
});

describe("ポートを改名前の mxstudio の橋渡しが持っているとき", () => {
  async function legacyBridge(): Promise<number> {
    const server = createServer((req, res) => {
      if (req.url === LEGACY_PEER_HEALTH_PATH) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: LEGACY_BRIDGE_NAME, version: "0.1.0\u001b[31m", protocol: 1 }));
        return;
      }
      // 改名前の橋渡しは知らない経路に画面（HTML）を返す
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>mxstudio</title>");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return (server.address() as AddressInfo).port;
  }

  it("probeBridgeHealth は renamed を返す（版の文字は表示できる ASCII だけ）", async () => {
    const port = await legacyBridge();
    expect(await probeBridgeHealth(port)).toEqual({ kind: "renamed", version: "0.1.0[31m" });
  });

  it("橋渡しは起動をやめ、LLM のアプリを終了して導入をやり直すよう知らせる", async () => {
    const port = await legacyBridge();
    const home = await tempHome();
    const coordinator = new BridgeCoordinator({ port, root: home, keyStore: new BridgeKeyStore(join(home, "bridge.key")), version: "test", log: () => undefined });
    const started = await coordinator.start();
    expect(started.kind).toBe("conflict");
    if (started.kind === "conflict") {
      expect(started.message).toContain("改名前の mxstudio の橋渡し");
      expect(started.message).toContain("mxstage.cmd");
    }
  });
});
