// 接続先ごとの置き場所（既定のフォルダ）、接続先の Skill・この PC だけの Skill・AI の案（src/bridge/sharedSkills.ts）と、
// AI に渡す Skill が作業画面の今の接続先のものだけであること（src/bridge/mcp.ts）。

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILLS as DEFAULT_SKILLS } from "../../src/bridge/defaultSkills.ts";
import { DictionaryStore, folderNameOf, scopeKeyOf, SHARE_DIR_NAME } from "../../src/bridge/dictionaries.ts";
import { buildBridgeMcpServer } from "../../src/bridge/mcp.ts";
import { PC_DRAFT_SCOPE, SkillShelf } from "../../src/bridge/sharedSkills.ts";
import { SKILLS_CHECK_PATH, SKILLS_GET_PATH, SKILLS_PATH, SKILLS_PLACES_PATH, SKILLS_SAVE_PATH } from "../../src/bridge/skillRoutes.ts";
import { readSkillCatalog, skillFileText } from "../../src/bridge/skills.ts";
import type { HubRpc, HubStatus } from "../../src/shared/protocol.ts";
import { findSecrets } from "../../src/shared/secretText.ts";
import { rawRequest, startTestBridge, stopAll } from "./support.ts";

const dirs: string[] = [];
function tempDir(prefix = "mxs-skill-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KITA = "c_00000000000000a1";
const MINAMI = "c_00000000000000b2";
const LABELS: Record<string, string> = { [KITA]: "北部クリーンセンター（本番）", [MINAMI]: "南部工場（テスト）" };
let clock = Date.parse("2026-10-18T00:00:00Z");
const tick = () => (clock += 1000);

function setup() {
  const stateDir = tempDir("mxs-state-");
  const documents = tempDir("mxs-docs-");
  const userSkillsDir = join(stateDir, "skills");
  const store = new DictionaryStore({ stateDir, now: tick, env: {}, documentsDir: documents, labelOf: (k) => LABELS[k] ?? null });
  const shelf = new SkillShelf({ store, userSkillsDir, now: tick });
  return { stateDir, documents, userSkillsDir, store, shelf };
}

const skill = (name: string, description = "Use for the daily report of this customer.", body = "# Steps\n\n1. Read the report with describe_import.\n2. Check with get_diff.") => ({ name, description, body });

describe("接続先ごとの置き場所", () => {
  it("選んでいなければ、ドキュメント\\MX Stage\\<接続先の名前> にする。初めて書くまでフォルダは作らない", async () => {
    const { store, documents } = setup();
    store.ensurePlace(KITA);
    const info = store.folderInfo(KITA);
    expect(info).toMatchObject({ path: null, isDefault: true, reachable: true, writable: true, root: join(documents, SHARE_DIR_NAME, "北部クリーンセンター（本番）") });
    expect(existsSync(info.root)).toBe(false);
    await store.create(KITA, { name: "設備の呼び名", kind: "alias" });
    expect(existsSync(join(info.root, "dictionaries"))).toBe(true);
    // 一度決めたら、接続先の名前を変えても動かさない
    LABELS[KITA] = "北部CC";
    expect(store.rootOf(KITA)).toBe(info.root);
    LABELS[KITA] = "北部クリーンセンター（本番）";
  });

  it("同じ名前の接続先は (2) を付けて分け、使えない文字は _ にする", () => {
    const { store, documents } = setup();
    const labels: Record<string, string> = { c_0000000000000001: "本番: A/B", c_0000000000000002: "本番: A/B" };
    const s = new DictionaryStore({ stateDir: tempDir(), env: {}, documentsDir: documents, labelOf: (k) => labels[k] ?? null });
    s.ensurePlace("c_0000000000000001");
    s.ensurePlace("c_0000000000000002");
    expect(s.rootOf("c_0000000000000001")).toBe(join(documents, SHARE_DIR_NAME, "本番_ A_B"));
    expect(s.rootOf("c_0000000000000002")).toBe(join(documents, SHARE_DIR_NAME, "本番_ A_B (2)"));
    expect(folderNameOf("con")).toBe("con_");
    expect(folderNameOf("  末尾の点. ")).toBe("末尾の点");
    // 保存していない接続先は Maximo のホスト名、デモは「デモ」
    store.ensurePlace(scopeKeyOf("https://maximo.example.jp")!, "maximo.example.jp");
    expect(store.rootOf(scopeKeyOf("https://maximo.example.jp")!)).toBe(join(documents, SHARE_DIR_NAME, "maximo.example.jp"));
    store.ensurePlace("demo-ja");
    expect(store.rootOf("demo-ja")).toBe(join(documents, SHARE_DIR_NAME, "デモ"));
  });

  it("0.2.8 までの置き場所（local-share）の辞書は、既定のフォルダへ移す", async () => {
    const { store, stateDir, documents } = setup();
    // まだ置き場所を決めていない接続先は、前の置き場所に書く（0.2.8 と同じ）
    const meta = await store.create(KITA, { name: "呼び名", kind: "alias" });
    expect(existsSync(join(stateDir, "local-share", KITA, "dictionaries", meta.id))).toBe(true);
    store.ensurePlace(KITA);
    expect(store.rootOf(KITA)).toBe(join(documents, SHARE_DIR_NAME, "北部クリーンセンター（本番）"));
    expect(store.list(KITA).map((d) => d.name)).toEqual(["呼び名"]);
    expect(existsSync(join(stateDir, "local-share", KITA))).toBe(false);
    expect(readdirSync(join(stateDir, "local-share")).some((n) => n.startsWith(`${KITA}.moved-`))).toBe(true);
  });

  it("共有フォルダを選ぶと、既定のフォルダの辞書と Skill を移し、元のフォルダはドキュメントに残さない", async () => {
    const { store, shelf, stateDir } = setup();
    store.ensurePlace(KITA);
    const before = store.folderInfo(KITA).root;
    await store.create(KITA, { name: "呼び名", kind: "alias" });
    expect(shelf.saveConnection(KITA, skill("kita-daily-report")).ok).toBe(true);
    const shared = tempDir("mxs-share-");
    const info = await store.setSharedFolder(KITA, shared);
    expect(info).toMatchObject({ path: shared, isDefault: false, root: join(shared, SHARE_DIR_NAME) });
    expect(store.list(KITA).map((d) => d.name)).toEqual(["呼び名"]);
    expect(shelf.listConnection(KITA).skills.map((s) => s.name)).toEqual(["kita-daily-report"]);
    expect(existsSync(before)).toBe(false);
    expect(readdirSync(join(stateDir, "moved")).some((n) => n.startsWith(`${KITA}-`))).toBe(true);
    // 今の置き場所の中は選べない
    await expect(store.setSharedFolder(KITA, join(shared, SHARE_DIR_NAME, "dictionaries"))).rejects.toMatchObject({ code: "invalid_folder" });
  });
});

describe("接続先の Skill", () => {
  it("保存のたびに版を足し、変更履歴から前の版に戻せる", () => {
    const { store, shelf } = setup();
    store.ensurePlace(KITA);
    const first = shelf.saveConnection(KITA, skill("kita-tagno", "Use to choose TAGNO again from the WO description."), { baseVersion: null });
    expect(first).toMatchObject({ ok: true, created: true });
    const v1 = first.ok ? first.skill.versionId : null;
    const second = shelf.saveConnection(KITA, { ...skill("kita-tagno", "Use to choose TAGNO again."), version: "0.2.0" }, { baseVersion: v1 });
    expect(second).toMatchObject({ ok: true, created: false, skill: { description: "Use to choose TAGNO again.", version: "0.2.0" } });
    const got = shelf.getConnection(KITA, "kita-tagno");
    expect(got.history.map((h) => h.version)).toEqual(["0.2.0", "0.1.0"]);
    const back = shelf.revertConnection(KITA, "kita-tagno", v1!);
    expect(back).toMatchObject({ ok: true, skill: { description: "Use to choose TAGNO again from the WO description.", version: "0.1.0" } });
    expect(shelf.getConnection(KITA, "kita-tagno").history).toHaveLength(3);
  });

  it("開いた後にほかの人が保存していれば conflict、同じ名前を新しく作ろうとすれば exists。force で置き換える", () => {
    const { store, shelf } = setup();
    store.ensurePlace(KITA);
    const first = shelf.saveConnection(KITA, skill("kita-tagno"));
    const opened = first.ok ? first.skill.versionId : null;
    // ほかのメンバー（別の PC）の版を足す
    const dir = join(store.rootOf(KITA), "skills", "kita-tagno", "versions");
    writeFileSync(join(dir, "20261018T120000000Z_m_00000000000000ff.md"), skillFileText({ name: "kita-tagno", description: "Changed by Sato.", body: "# Steps\n\nRead the report." }));
    mkdirSync(join(store.rootOf(KITA), "members"), { recursive: true });
    writeFileSync(join(store.rootOf(KITA), "members", "m_00000000000000ff.json"), JSON.stringify({ name: "佐藤" }));
    expect(shelf.getConnection(KITA, "kita-tagno").skill).toMatchObject({ description: "Changed by Sato.", updatedBy: "佐藤" });
    const mine = shelf.saveConnection(KITA, skill("kita-tagno", "Mine."), { baseVersion: opened });
    expect(mine).toMatchObject({ ok: false, code: "conflict", conflict: { by: "佐藤" } });
    expect(shelf.saveConnection(KITA, skill("kita-tagno", "Mine."), { baseVersion: null })).toMatchObject({ ok: false, code: "exists" });
    expect(shelf.saveConnection(KITA, skill("kita-tagno", "Mine."), { baseVersion: opened, force: true })).toMatchObject({ ok: true });
  });

  it("消すと一覧から外れ、変更履歴から戻せる", () => {
    const { store, shelf } = setup();
    store.ensurePlace(KITA);
    const saved = shelf.saveConnection(KITA, skill("kita-tagno"));
    expect(shelf.removeConnection(KITA, "kita-tagno")).toBe(true);
    const listed = shelf.listConnection(KITA);
    expect(listed.skills).toEqual([]);
    expect(listed.deleted.map((d) => d.name)).toEqual(["kita-tagno"]);
    expect(shelf.getConnection(KITA, "kita-tagno")).toMatchObject({ skill: null, problem: "deleted" });
    expect(shelf.revertConnection(KITA, "kita-tagno", saved.ok ? saved.skill.versionId! : "")).toMatchObject({ ok: true });
    expect(shelf.listConnection(KITA).skills.map((s) => s.name)).toEqual(["kita-tagno"]);
  });

  it("API キー・パスワードらしいもの、形の合わないもの、既定の Skill の名前は保存しない", () => {
    const { store, shelf } = setup();
    store.ensurePlace(KITA);
    expect(shelf.saveConnection(KITA, skill("kita-key", "Use for the API.", "# Steps\n\nUse apikey: 9fK2mQ7xL4pZ8vB1 for the API."))).toMatchObject({ ok: false, code: "secret" });
    expect(shelf.saveConnection(KITA, skill("Kita Report"))).toMatchObject({ ok: false, code: "invalid" });
    expect(shelf.saveConnection(KITA, skill("mxstage-core-load"))).toMatchObject({ ok: false, code: "invalid" });
    expect(shelf.listConnection(KITA).skills).toEqual([]);
  });

  it("2 つの接続先の Skill は互いに見えない", () => {
    const { store, shelf } = setup();
    store.ensurePlace(KITA);
    store.ensurePlace(MINAMI);
    shelf.saveConnection(KITA, skill("kita-tagno"));
    shelf.saveConnection(MINAMI, skill("minami-meter"));
    expect(shelf.listConnection(KITA).skills.map((s) => s.name)).toEqual(["kita-tagno"]);
    expect(shelf.listConnection(MINAMI).skills.map((s) => s.name)).toEqual(["minami-meter"]);
    expect(shelf.getConnection(MINAMI, "kita-tagno").skill).toBeNull();
  });
});

describe("この PC だけの Skill と AI の案", () => {
  it("保存・変更履歴・削除・元に戻す・接続先へ移す", () => {
    const { store, shelf, userSkillsDir } = setup();
    store.ensurePlace(KITA);
    // 0.2.8 までに save_skill で置いた Skill（履歴が無い）
    mkdirSync(join(userSkillsDir, "permit-update"), { recursive: true });
    writeFileSync(join(userSkillsDir, "permit-update", "SKILL.md"), skillFileText(skill("permit-update", "Old.")));
    const edited = shelf.savePc(skill("permit-update", "New."), { overwrite: true });
    expect(edited).toMatchObject({ ok: true, created: false });
    const history = shelf.getPc("permit-update").history;
    expect(history).toHaveLength(2);
    expect(shelf.revertPc("permit-update", history[1]!.id)).toMatchObject({ ok: true, skill: { description: "Old." } });
    expect(shelf.removePc("permit-update")).toBe(true);
    expect(existsSync(join(userSkillsDir, "permit-update"))).toBe(false);
    expect(shelf.getPc("permit-update").skill).toBeNull();
    shelf.savePc(skill("permit-update", "Again."));
    expect(shelf.movePcToConnection(KITA, "permit-update")).toMatchObject({ ok: true, skill: { place: "connection", description: "Again." } });
    expect(shelf.getPc("permit-update").skill).toBeNull();
    expect(shelf.listConnection(KITA).skills.map((s) => s.name)).toEqual(["permit-update"]);
  });

  it("AI の案は接続先ごとに残り、捨てられる。API キーらしいものは案にもしない", () => {
    const { shelf } = setup();
    expect(shelf.saveDraft(KITA, skill("kita-daily-report")).ok).toBe(true);
    expect(shelf.saveDraft(PC_DRAFT_SCOPE, skill("pc-only")).ok).toBe(true);
    expect(shelf.listDrafts(KITA).map((d) => d.name)).toEqual(["kita-daily-report"]);
    expect(shelf.listDrafts(MINAMI)).toEqual([]);
    expect(shelf.saveDraft(KITA, skill("kita-secret", "x", "password = Hk38dkq0Zr"))).toMatchObject({ ok: false, code: "secret" });
    expect(shelf.discardDraft(KITA, "kita-daily-report")).toBe(true);
    expect(shelf.listDrafts(KITA)).toEqual([]);
  });

  it("同じ名前なら接続先の Skill を使い、この PC だけの Skill は外す", () => {
    const { userSkillsDir } = setup();
    mkdirSync(join(userSkillsDir, "daily-report"), { recursive: true });
    writeFileSync(join(userSkillsDir, "daily-report", "SKILL.md"), skillFileText(skill("daily-report", "From this PC.")));
    const catalog = readSkillCatalog(userSkillsDir, { label: "北部", skills: [{ name: "daily-report", description: "From the connection.", version: "0.1.0", body: "# x" }] });
    const found = catalog.skills.filter((s) => s.name === "daily-report");
    expect(found).toEqual([expect.objectContaining({ origin: "connection", description: "From the connection." })]);
    expect(catalog.problems).toEqual([expect.objectContaining({ name: "daily-report", level: "warn" })]);
  });
});

describe("API キー・パスワードらしいもの", () => {
  it.each([
    ["apikey: q8Zr4LmW2xT9vB7n"],
    ["MAXAUTH=bWF4YWRtaW46bWF4YWRtaW4="],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef"],
    ["-----BEGIN RSA PRIVATE KEY-----"],
    ["use 3c9f1a7e5b2d4f6a8c0e9b7d5f3a1c2e when asked"],
  ])("%s", (text) => {
    expect(findSecrets(text)).toHaveLength(1);
  });

  it.each([["apikey: <API キー>"], ["password: xxxxxxxx"], ["name kita-daily-report-2026-10"], ["ASSETNUM CRANE-001"], ["mxstage-obj-item-inventory"]])("%s は止めない", (text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  it("既定の Skill はどれも止めない", () => {
    for (const s of DEFAULT_SKILLS) expect(findSecrets(s.body), s.name).toEqual([]);
  });
});

describe("AI に渡す Skill は作業画面の今の接続先のものだけ", () => {
  async function connect(shelf: SkillShelf, userSkillsDir: string, connection: { value: string | null }) {
    const hub = {
      invoke: () => Promise.resolve({ ok: true, result: { content: [{ type: "text", text: "{}" }], structuredContent: {} } }),
      status: (): Promise<HubStatus> =>
        Promise.resolve({ tabs: [{ tabId: "t1", role: "primary", workspace: null, appVersion: "test", connectedAt: 0, connection: connection.value }], primaryTabId: "t1" }),
      pushImport: () => Promise.resolve({ delivered: false }),
    } as unknown as HubRpc;
    const server = buildBridgeMcpServer({ origin: "http://127.0.0.1:1", hub, tickets: { create: () => Promise.reject(new Error("unused")) }, version: "0.0.0", userSkillsDir, skillShelf: shelf });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
  }
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

  it("最初の結果は今の接続先の Skill だけを並べ、切り替えたら次の結果で新しい接続先の一覧を渡す。get_skill もその接続先で引く", async () => {
    const { store, shelf, userSkillsDir } = setup();
    store.ensurePlace(KITA);
    store.ensurePlace(MINAMI);
    shelf.saveConnection(KITA, skill("kita-tagno", "Use to choose TAGNO again for Kita."));
    shelf.saveConnection(MINAMI, skill("minami-meter", "Use to read meters for Minami."));
    const connection = { value: KITA as string | null };
    const client = await connect(shelf, userSkillsDir, connection);

    const first = text(await client.callTool({ name: "get_status", arguments: {} }));
    expect(first).toContain("Skills of this connection: 北部クリーンセンター（本番）");
    expect(first).toContain("kita-tagno");
    expect(first).not.toContain("minami-meter");
    expect(await client.callTool({ name: "get_skill", arguments: { name: "kita-tagno" } })).toMatchObject({ structuredContent: { origin: "connection", connection: "北部クリーンセンター（本番）" } });

    // 作業画面を南部につなぎ替える
    connection.value = MINAMI;
    const after = text(await client.callTool({ name: "get_status", arguments: {} }));
    expect(after).toContain("now connected to 南部工場（テスト）");
    expect(after).toContain("minami-meter");
    expect(after).toContain("those of the previous connection do not apply");
    const stale = await client.callTool({ name: "get_skill", arguments: { name: "kita-tagno" } });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("for the connection of the work screen (南部工場（テスト）)");
    const listed = (await client.callTool({ name: "list_skills", arguments: {} })).structuredContent as { skills: { name: string }[]; connection: string };
    expect(listed.connection).toBe("南部工場（テスト）");
    expect(listed.skills.map((s) => s.name)).toContain("minami-meter");
    expect(listed.skills.map((s) => s.name)).not.toContain("kita-tagno");
    // 同じ接続先のままなら、一覧を添え直さない
    expect(text(await client.callTool({ name: "get_status", arguments: {} }))).not.toContain("now connected");
  });

  it("save_skill は今の接続先の AI の案にし、Skill としては使わない", async () => {
    const { store, shelf, userSkillsDir } = setup();
    store.ensurePlace(KITA);
    const connection = { value: KITA as string | null };
    const client = await connect(shelf, userSkillsDir, connection);
    const saved = await client.callTool({ name: "save_skill", arguments: skill("kita-daily-report") });
    expect(saved).toMatchObject({ structuredContent: { draft: "kita-daily-report", connection: "北部クリーンセンター（本番）" } });
    expect(shelf.listDrafts(KITA).map((d) => d.name)).toEqual(["kita-daily-report"]);
    expect(shelf.listConnection(KITA).skills).toEqual([]);
    expect((await client.callTool({ name: "get_skill", arguments: { name: "kita-daily-report" } })).isError).toBe(true);
  });
});

describe("設定の入口（/_mxstage/skills）", () => {
  it("一覧・置き場所・保存（作業画面からだけ）・読む", async () => {
    const { store, shelf, userSkillsDir } = setup();
    const bridge = await startTestBridge({ dictionaries: store, skillShelf: shelf, userSkillsDir });
    const json = { "Content-Type": "application/json", Origin: bridge.origin };
    const body = JSON.stringify({ scope: KITA, place: "connection", ...skill("kita-tagno"), baseVersion: null });
    // ブラウザの作業画面からでない書き込みは断る（AI が設定を通さずに保存しないように）
    const blocked = await rawRequest(bridge, SKILLS_SAVE_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(blocked.status).toBe(403);
    const saved = await rawRequest(bridge, SKILLS_SAVE_PATH, { method: "POST", headers: json, body });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ ok: true, created: true, skill: { name: "kita-tagno", place: "connection" } });
    const list = JSON.parse((await rawRequest(bridge, `${SKILLS_PATH}?scope=${KITA}`)).body);
    expect(list.connection).toMatchObject({ label: "北部クリーンセンター（本番）", folder: { isDefault: true }, skills: [{ name: "kita-tagno" }] });
    expect(list.skills.every((s: { origin: string }) => s.origin !== "connection")).toBe(true);
    const places = JSON.parse((await rawRequest(bridge, `${SKILLS_PLACES_PATH}?scope=${KITA}&scope=${MINAMI}`)).body);
    expect(places.places.map((p: { label: string; skills: number }) => [p.label, p.skills])).toEqual([
      ["北部クリーンセンター（本番）", 1],
      ["南部工場（テスト）", 0],
    ]);
    const got = JSON.parse((await rawRequest(bridge, `${SKILLS_GET_PATH}?scope=${KITA}&place=connection&name=kita-tagno`)).body);
    expect(got).toMatchObject({ ok: true, skill: { name: "kita-tagno" }, history: [{ deleted: false }] });
    // 保存の前に確かめる: ほかの客先の名前が本文にあれば知らせる
    const check = JSON.parse(
      (await rawRequest(bridge, SKILLS_CHECK_PATH, { method: "POST", headers: json, body: JSON.stringify({ scope: MINAMI, ...skill("minami-x", "Use for Minami.", "Same as 北部クリーンセンター（本番）.") }) })).body,
    );
    expect(check).toMatchObject({ ok: true, otherCustomers: ["北部クリーンセンター（本番）"], check: { errors: [], secrets: [] } });
  });
});
