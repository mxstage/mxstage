// シートを読み込んだオブジェクト構造で Maximo に反映することの試験。
// - 同じ構造を複数のシートで使い、それぞれ反映できる（送信先はその構造のレコード）。
// - シートを読み込んだ接続先と今の接続先が違えば反映しない。
// - シートを読み込んだ後に構造の定義を取り直し、反映に使う列が変わっていたら反映しない（関係しない列の変化では止めない）。

import { describe, expect, it } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { structureDriftProblems } from "../../src/app/catalog/drift";
import { createCommitController } from "../../src/app/commit/controller";
import { MaximoClient } from "../../src/app/maximo/client";
import type { ObjectStructureInfo } from "../../src/app/maximo/meta";
import type { ToolContext } from "../../src/app/relay";
import type { MaximoConnection } from "../../src/app/runtime/contracts";
import { JobRegistry, Workspace } from "../../src/app/store";
import { createToolRegistry } from "../../src/app/tools/registry";
import type { InvokeMsg } from "../../src/shared/protocol";
import { makeChildRowKey, makeParentKey, type SheetMeta } from "../../src/shared/sheet";
import type { ToolName } from "../../src/shared/toolDefs";
import { createFakeMaximo, sampleSeed } from "../fakes/fake-maximo";

const SELECT = ["WONUM", "SITEID", "DESCRIPTION", "STATUS"];

function harness() {
  const fake = createFakeMaximo(sampleSeed());
  const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} });
  let conn: MaximoConnection = { info: { baseUrl: fake.baseUrl, via: "direct", connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1 }, client };
  const listeners = new Set<() => void>();
  const connection = {
    current: () => conn,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    /** 別の接続先に接続し直した（同じ偽物につながったまま、接続先の名前だけ変える） */
    switchTo(baseUrl: string) {
      conn = { ...conn, info: { ...conn.info, baseUrl, connectedAt: conn.info.connectedAt + 1 } };
      for (const l of Array.from(listeners)) l();
    },
  };
  const workspace = new Workspace("作業");
  let t = 1_000;
  const catalog = new ObjectStructureCatalog({ now: () => ++t });
  const commits = createCommitController({ workspace, connection, catalog, refreshMs: 0 });
  const registry = createToolRegistry({ workspace, jobs: new JobRegistry(), connection, commits, catalog, appVersion: "0.1.0-test", appUrl: "https://mxstage.test/app" });
  let seq = 0;
  async function call(tool: string, args: unknown): Promise<Record<string, any>> {
    const msg: InvokeMsg = { type: "tool.invoke", id: `c${++seq}`, tool: tool as ToolName, args, deadlineAt: Date.now() + 30_000, timeoutMs: 30_000, idempotencyKey: "", readOnly: false };
    const ctx: ToolContext = { signal: new AbortController().signal, progress: () => {} };
    return (await registry.handler(msg, ctx)).result.structuredContent as Record<string, any>;
  }
  /** 作業画面の [Maximo に反映] と、カナリアの続行 */
  async function runCommit(sheet: string) {
    const running = commits.run(sheet, {});
    for (let i = 0; i < 200 && commits.panel(sheet).awaitingCanary === null && commits.panel(sheet).state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    if (commits.panel(sheet).awaitingCanary !== null) commits.continueCanary(sheet, true);
    return running;
  }
  const osState = (name: string) => Object.values(fake.state.os).find((o) => o.name.toUpperCase() === name)!;
  return { fake, client, connection, workspace, catalog, commits, call, runCommit, osState };
}

type Harness = ReturnType<typeof harness>;

async function loadAndEdit(h: Harness, sheet: string, site: string, wonum: string, col: string, value: string) {
  await h.call("load_sheet", { name: sheet, os: "MXAPIWO", select: SELECT, where: [{ attr: "SITEID", op: "eq", value: site }] });
  const st = await h.call("get_status", {});
  const res = await h.call("patch_cells", { sheet, edits: [{ rowKey: makeParentKey([site, wonum]), col, value }], baseRevision: st.revision, reason: "試験" });
  expect(res.applied).toBe(1);
}

describe("シートを読み込んだ構造で反映する", () => {
  it("同じ構造で読み込んだ 2 つのシートは、それぞれその構造のレコードに反映する", async () => {
    const h = harness();
    await h.catalog.syncAll(h.client, h.fake.baseUrl);
    await loadAndEdit(h, "WO-BEDFORD", "BEDFORD", "WO1003", "DESCRIPTION", "塗装（更新）");
    await loadAndEdit(h, "WO-TKY", "TKY", "WO1005", "DESCRIPTION", "ポンプ交換（更新）");

    for (const sheet of ["WO-BEDFORD", "WO-TKY"]) {
      const p = h.commits.panel(sheet);
      expect(p.target).toEqual({ os: "MXAPIWO", baseUrl: h.catalog.get(h.fake.baseUrl, "MXAPIWO")!.baseUrl });
      expect(p.blockers).toEqual([]);
      const done = await h.runCommit(sheet);
      expect(done.state).toBe("done");
      expect(done.results.map((r) => r.status)).toEqual(["verified"]);
    }
    const posts = h.fake.state.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBe(2);
    expect(posts.every((r) => r.path.toLowerCase().startsWith("/maximo/api/os/mxapiwo/"))).toBe(true);
    expect(h.fake.records("mxapiwo").find((r) => r.attrs.wonum === "WO1005")?.attrs.description).toBe("ポンプ交換（更新）");
  });

  it("シートを読み込んだ接続先と今の接続先が違えば、反映しない（送らない）", async () => {
    const h = harness();
    await loadAndEdit(h, "WO", "BEDFORD", "WO1003", "DESCRIPTION", "塗装（更新）");
    h.connection.switchTo("https://other-maximo.example.com");
    const p = h.commits.panel("WO");
    expect(p.blockers.some((b) => b.includes("今の接続先（https://other-maximo.example.com）には反映できません"))).toBe(true);
    const result = await h.commits.run("WO", {});
    expect(result.state).not.toBe("done");
    expect(result.message).toContain("反映できません");
    expect(h.fake.writeCount()).toBe(0);
  });

  it("読み込んだ後に定義を取り直し、変更した列が読み取り専用になっていたら反映しない", async () => {
    const h = harness();
    await h.catalog.syncAll(h.client, h.fake.baseUrl);
    await loadAndEdit(h, "WO", "BEDFORD", "WO1003", "DESCRIPTION", "塗装（更新）");
    expect(h.commits.panel("WO").blockers).toEqual([]);

    // Maximo 側で DESCRIPTION を読み取り専用にし、作業画面が定義を取り直した
    h.osState("MXAPIWO").def.attrs.description = { type: "string", maxLength: 100, readOnly: true };
    await h.catalog.ensure(h.client, h.fake.baseUrl, "MXAPIWO", { refresh: true });
    const blockers = h.commits.panel("WO").blockers;
    expect(blockers.some((b) => b.includes("オブジェクト構造 MXAPIWO の定義が取り直され") && b.includes("列 DESCRIPTION が読み取り専用になりました"))).toBe(true);
    const result = await h.commits.run("WO", {});
    expect(result.state).not.toBe("done");
    expect(h.fake.writeCount()).toBe(0);

    // 読み込み直せば、今の定義で判断する（読み取り専用の列はもう変更できない）
    await h.commits.dismiss("WO");
  });

  it("取り直した定義で変わったのが反映に使わない列なら、止めない", async () => {
    const h = harness();
    await h.catalog.syncAll(h.client, h.fake.baseUrl);
    await loadAndEdit(h, "WO", "BEDFORD", "WO1003", "DESCRIPTION", "塗装（更新）");
    h.osState("MXAPIWO").def.attrs.status = { type: "string", maxLength: 16, readOnly: true };
    await h.catalog.ensure(h.client, h.fake.baseUrl, "MXAPIWO", { refresh: true });
    expect(h.commits.panel("WO").blockers).toEqual([]);
    const done = await h.runCommit("WO");
    expect(done.state).toBe("done");
  });
});

describe("structureDriftProblems", () => {
  const meta: SheetMeta = {
    name: "s",
    source: { kind: "maximo", os: "MXAPIWO", select: [], where: [] },
    columns: [
      { name: "SITEID", type: "string" },
      { name: "WONUM", type: "string" },
      { name: "DESCRIPTION", type: "string", maxLength: 100 },
      { name: "WOPRIORITY", type: "integer" },
      { name: "EXT_WOPERMIT.EXT_PERMITDATE", type: "date", child: "EXT_WOPERMIT" },
    ],
    keyColumns: ["SITEID", "WONUM"],
    childIdAttrs: { EXT_WOPERMIT: "EXT_WOPERMITID" },
  };
  const info = (patch: Partial<ObjectStructureInfo> = {}): ObjectStructureInfo => ({ os: "MXAPIWO", columns: meta.columns, keyColumns: ["SITEID", "WONUM"], childIdAttrs: { EXT_WOPERMIT: "EXT_WOPERMITID" }, ...patch });
  const pk = makeParentKey(["BEDFORD", "WO1"]);
  const childKey = makeChildRowKey(pk, "EXT_WOPERMIT", 7);
  const changes = {
    cells: [
      { rowKey: pk, col: "DESCRIPTION", value: "x" },
      { rowKey: childKey, col: "EXT_WOPERMIT.EXT_PERMITDATE", value: "2026-09-30" },
    ],
    addedRows: [],
    deletedRows: [],
  };

  it("変わっていなければ空", () => {
    expect(structureDriftProblems(meta, info(), changes)).toEqual([]);
  });

  it("反映に使う列が無くなった・型や桁が変わった・子を特定する属性が変わった・キー列が変わったら知らせる", () => {
    const problems = structureDriftProblems(
      meta,
      info({
        columns: [
          { name: "SITEID", type: "string" },
          { name: "WONUM", type: "string" },
          { name: "DESCRIPTION", type: "string", maxLength: 50 },
          { name: "WOPRIORITY", type: "string" },
        ],
        childIdAttrs: { EXT_WOPERMIT: null },
        keyColumns: ["WONUM"],
      }),
      changes,
    );
    expect(problems).toEqual([
      "列 DESCRIPTION の桁が 100 から 50 に減りました",
      "列 EXT_WOPERMIT.EXT_PERMITDATE が無くなりました",
      "子オブジェクト EXT_WOPERMIT を特定する属性が EXT_WOPERMITID から 不明 に変わりました",
      "キー列が SITEID, WONUM から WONUM に変わりました",
    ]);
  });

  it("変更に使わない列の違い（WOPRIORITY の型）は問わない", () => {
    const cols = meta.columns.map((c) => (c.name === "WOPRIORITY" ? { ...c, type: "string" as const } : c));
    expect(structureDriftProblems(meta, info({ columns: cols }), changes)).toEqual([]);
  });
});
