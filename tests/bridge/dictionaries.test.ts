// 客先の辞書と共有フォルダ（src/bridge/dictionaries.ts）と、その入口（/_mxstage/dictionaries・/_mxstage/shared-folder）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DictionaryStore, detectSync, scopeKeyOf, SHARE_DIR_NAME } from "../../src/bridge/dictionaries.ts";
import { DICTIONARIES_CREATE_PATH, DICTIONARIES_GET_PATH, DICTIONARIES_PATH, DICTIONARIES_SAVE_PATH, SHARED_FOLDER_PATH } from "../../src/bridge/dictionaryRoutes.ts";
import { rawRequest, startTestBridge, stopAll } from "./support.ts";

const dirs: string[] = [];
function tempDir(prefix = "mxs-dict-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SCOPE = "c_0123456789abcdef";
let clock = Date.parse("2026-10-13T00:00:00Z");
const tick = () => (clock += 1000);

function store(stateDir = tempDir()): DictionaryStore {
  return new DictionaryStore({ stateDir, now: tick, env: {} });
}

const entry = (find: string, to: string, mode: "text" | "regex" = "text", note = "") => ({ find, to, mode, note });

describe("辞書の保存と読み込み", () => {
  it("作って、足して、直して、消す。項目に ID が付き、履歴に残る", async () => {
    const s = store();
    const meta = await s.create(SCOPE, { name: "設備の呼び名", kind: "alias" });
    expect(meta.name).toBe("設備の呼び名");
    const first = await s.save(SCOPE, meta.id, [{ op: "put", entry: entry("#(\\d)", "$1号炉", "regex") }, { op: "put", entry: entry("ごみクレ", "ごみクレーン") }]);
    expect(first.ids).toHaveLength(2);
    expect(first.state.entries.map((e) => e.find)).toEqual(["#(\\d)", "ごみクレ"]);
    const crane = first.ids[1]!;
    const second = await s.save(SCOPE, meta.id, [{ op: "put", id: crane, entry: entry("ごみクレ", "ごみクレーン", "text", "現場の略し方") }, { op: "delete", id: first.ids[0]! }]);
    expect(second.state.entries).toEqual([expect.objectContaining({ id: crane, note: "現場の略し方", rev: 2 })]);
    expect(second.state.history.map((h) => [h.added, h.changed, h.deleted])).toEqual([
      [0, 1, 1],
      [2, 0, 0],
    ]);
    expect(s.list(SCOPE)).toEqual([expect.objectContaining({ name: "設備の呼び名", count: 1 })]);
    // 同じ名前は作れない
    await expect(s.create(SCOPE, { name: " 設備の呼び名 ", kind: "alias" })).rejects.toMatchObject({ code: "name_taken" });
    // 使えない項目は保存しない
    await expect(s.save(SCOPE, meta.id, [{ op: "put", entry: entry("(ポンプ", "x", "regex") }])).rejects.toMatchObject({ code: "invalid_entry" });
  });

  it("メンバーごとのファイルにだけ追記し、読むときに全員分を合わせる（同じ項目は新しい方）", async () => {
    const stateDir = tempDir();
    const s = store(stateDir);
    const meta = await s.create(SCOPE, { name: "呼び名", kind: "alias" });
    const mine = await s.save(SCOPE, meta.id, [{ op: "put", entry: entry("B号", "B号機") }]);
    const id = mine.ids[0]!;
    const changes = join(s.rootOf(SCOPE), "dictionaries", meta.id, "changes");
    const me = s.member().id;
    expect(readdirSync(changes)).toEqual([`${me}.jsonl`]);
    // 別のメンバー（田中）が、同じ項目を直し、新しい項目を足した
    const other = "m_ffffffffffffffff";
    mkdirSync(join(s.rootOf(SCOPE), "members"), { recursive: true });
    writeFileSync(join(s.rootOf(SCOPE), "members", `${other}.json`), JSON.stringify({ name: "田中" }));
    const at = new Date(clock + 60_000).toISOString();
    appendFileSync(
      join(changes, `${other}.jsonl`),
      [
        { v: 1, op: "put", id, rev: 2, at, save: "s_1111111111111111", entry: entry("温水循環ポンプB号", "温水循環ポンプ B号機") },
        { v: 1, op: "put", id: "e_2222222222222222", rev: 1, at, save: "s_1111111111111111", entry: entry("ごみクレ", "ごみクレーン") },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\nnot json\n" + JSON.stringify({ v: 1, op: "put", id: "bad" }) + "\n",
    );
    const state = s.get(SCOPE, meta.id);
    expect(state.entries.map((e) => [e.find, e.updatedBy])).toEqual([
      ["温水循環ポンプB号", "田中"],
      ["ごみクレ", "田中"],
    ]);
    expect(state.problems.map((p) => [p.line, p.message, p.by])).toEqual([
      [3, "not_json", "田中"],
      [4, "invalid_change", "田中"],
    ]);
    // 自分のファイル以外は書かない
    const before = readFileSync(join(changes, `${other}.jsonl`), "utf8");
    await s.save(SCOPE, meta.id, [{ op: "delete", id: "e_2222222222222222" }]);
    expect(readFileSync(join(changes, `${other}.jsonl`), "utf8")).toBe(before);
    expect(s.get(SCOPE, meta.id).entries.map((e) => e.find)).toEqual(["温水循環ポンプB号"]);
  });

  it("保存を元に戻す。あとで別の人が変えた項目は戻さない", async () => {
    const s = store();
    const meta = await s.create(SCOPE, { name: "呼び名", kind: "alias" });
    const a = await s.save(SCOPE, meta.id, [{ op: "put", entry: entry("ごみクレ", "ごみクレーン") }]);
    const b = await s.save(SCOPE, meta.id, [
      { op: "put", id: a.ids[0]!, entry: entry("ごみクレ", "ごみクレーン", "text", "メモ") },
      { op: "put", entry: entry("#3", "3号炉") },
    ]);
    const r = await s.revert(SCOPE, meta.id, b.saveId);
    expect(r).toMatchObject({ reverted: 2, skipped: 0 });
    expect(r.state.entries.map((e) => [e.find, e.note])).toEqual([["ごみクレ", ""]]);
    // 最初の保存を戻そうとしても、その項目はあとの保存（戻したもの）が一番新しいので戻さない
    const r2 = await s.revert(SCOPE, meta.id, a.saveId);
    expect(r2).toMatchObject({ reverted: 0, skipped: 1 });
  });

  it("共有フォルダを付けると、この PC の辞書を写し、客先の名前と接続先（API キーなし）を書く", async () => {
    const stateDir = tempDir();
    const s = store(stateDir);
    const meta = await s.create(SCOPE, { name: "呼び名", kind: "alias" });
    await s.save(SCOPE, meta.id, [{ op: "put", entry: entry("ごみクレ", "ごみクレーン") }]);
    expect(s.folderInfo(SCOPE)).toEqual({ path: null, sync: null, reachable: true, writable: true });
    const shared = tempDir("mxs-share-");
    const info = await s.setSharedFolder(SCOPE, shared, { name: "北部クリーンセンター", connections: [{ name: "本番", baseUrl: "https://maximo.example.lg.jp", environment: "production" }] });
    expect(info).toMatchObject({ path: shared, reachable: true, writable: true });
    expect(s.rootOf(SCOPE)).toBe(join(shared, SHARE_DIR_NAME));
    expect(s.list(SCOPE).map((d) => [d.name, d.count])).toEqual([["呼び名", 1]]);
    const project = JSON.parse(readFileSync(join(shared, SHARE_DIR_NAME, "project.json"), "utf8"));
    expect(project).toEqual({ format: "mxstage-project/1", name: "北部クリーンセンター", connections: [{ name: "本番", baseUrl: "https://maximo.example.lg.jp", environment: "production" }] });
    expect(existsSync(join(shared, SHARE_DIR_NAME, "README.txt"))).toBe(true);
    // この PC の元は消さずに名前を変えて残す
    expect(readdirSync(join(stateDir, "local-share")).some((n) => n.startsWith(`${SCOPE}.moved-`))).toBe(true);
    // 共有フォルダに届かなければ unreachable
    rmSync(shared, { recursive: true, force: true });
    expect(s.folderInfo(SCOPE)).toMatchObject({ reachable: false, writable: false });
    expect(() => s.list(SCOPE)).toThrow(expect.objectContaining({ code: "unreachable" }));
    // 外すと、この PC の置き場に戻る
    await s.setSharedFolder(SCOPE, null);
    expect(s.folderInfo(SCOPE).path).toBe(null);
  });

  it("言葉 → コードの辞書: 項目・絞り込みを保存して読み、項目の無い項目は断る", async () => {
    const s = store();
    const meta = await s.create(SCOPE, { name: "故障の言葉", kind: "code" });
    expect(meta.kind).toBe("code");
    const saved = await s.save(SCOPE, meta.id, [{ op: "put", entry: { find: "漏れ", to: "LEAK", mode: "text", note: "", field: "PROBLEM", scope: "PUMP, VALVE" } }]);
    expect(saved.state.entries).toEqual([expect.objectContaining({ find: "漏れ", to: "LEAK", field: "PROBLEM", scope: "PUMP, VALVE" })]);
    await expect(s.save(SCOPE, meta.id, [{ op: "put", entry: { find: "異音", to: "NOISE", mode: "text", note: "" } }])).rejects.toMatchObject({ code: "invalid_entry" });
    const v = await s.create(SCOPE, { name: "メーカー名", kind: "value" });
    const vs = await s.save(SCOPE, v.id, [{ op: "put", entry: { find: "三菱電機(株)", to: "三菱電機", mode: "text", note: "", column: "MANUFACTURER" } }]);
    expect(vs.state.entries[0]).toMatchObject({ column: "MANUFACTURER" });
    expect(s.list(SCOPE).map((d) => [d.name, d.kind])).toEqual([
      ["メーカー名", "value"],
      ["故障の言葉", "code"],
    ]);
  });

  it("接続先のキーと、同期の仕組みの見分け", () => {
    expect(scopeKeyOf(SCOPE)).toBe(SCOPE);
    expect(scopeKeyOf("demo-ja")).toBe("demo-ja");
    expect(scopeKeyOf("https://maximo.example.com")).toMatch(/^o_[0-9a-f]{16}$/);
    expect(scopeKeyOf("https://maximo.example.com/")).toBe(scopeKeyOf("https://maximo.example.com"));
    expect(scopeKeyOf("http://x")).toBe(null);
    expect(scopeKeyOf("../etc")).toBe(null);
    const env = { OneDriveCommercial: "C:\\Users\\a\\OneDrive - Contoso", OneDriveConsumer: "C:\\Users\\a\\OneDrive" };
    if (process.platform === "win32") {
      expect(detectSync("C:\\Users\\a\\OneDrive - Contoso\\保守\\北部", env, "C:\\Users\\a")).toBe("onedrive-business");
      expect(detectSync("C:\\Users\\a\\Contoso\\北部CC - ドキュメント", env, "C:\\Users\\a")).toBe("sharepoint");
      expect(detectSync("C:\\Users\\a\\OneDrive\\x", env, "C:\\Users\\a")).toBe("onedrive");
      expect(detectSync("\\\\fileserver\\share\\x", env, "C:\\Users\\a")).toBe("network");
      expect(detectSync("C:\\Users\\a\\Box\\x", {}, "C:\\Users\\a")).toBe("box");
      expect(detectSync("C:\\work\\x", env, "C:\\Users\\a")).toBe("local");
    } else {
      expect(detectSync("/home/a/Dropbox/x", {}, "/home/a")).toBe("dropbox");
      expect(detectSync("/home/a/work", {}, "/home/a")).toBe("local");
    }
  });
});

const JSON_HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

describe("入口（/_mxstage/dictionaries）", () => {
  it("作る・保存する・読む。ほかのサイトからは受けない", async () => {
    const bridge = await startTestBridge({ dictionaries: store() });
    const post = (path: string, body: unknown) => rawRequest(bridge, path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const created = await post(DICTIONARIES_CREATE_PATH, { scope: SCOPE, name: "設備の呼び名", kind: "alias" });
    expect(created.status).toBe(200);
    const id = JSON.parse(created.body).dictionary.id as string;
    const saved = await post(DICTIONARIES_SAVE_PATH, { scope: SCOPE, id: "設備の呼び名", ops: [{ op: "put", entry: entry("#3", "3号炉") }] });
    expect(JSON.parse(saved.body)).toMatchObject({ ok: true, entries: [{ find: "#3", to: "3号炉" }] });
    const list = await rawRequest(bridge, `${DICTIONARIES_PATH}?scope=${SCOPE}`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(JSON.parse(list.body)).toMatchObject({ ok: true, folder: { path: null }, dictionaries: [{ id, name: "設備の呼び名", count: 1 }] });
    const got = await rawRequest(bridge, `${DICTIONARIES_GET_PATH}?scope=${SCOPE}&id=${id}`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(JSON.parse(got.body)).toMatchObject({ ok: true, dictionary: { id }, entries: [{ find: "#3" }], history: [{ added: 1 }] });
    const bad = await post(DICTIONARIES_SAVE_PATH, { scope: SCOPE, id, ops: [{ op: "put", entry: entry("", "x") }] });
    expect(bad.status).toBe(422);
    const missing = await post(SHARED_FOLDER_PATH, { scope: SCOPE, path: join(tmpdir(), "mxs-does-not-exist-xyz") });
    expect(JSON.parse(missing.body)).toMatchObject({ ok: false, error: "invalid_folder" });
    const crossSite = await rawRequest(bridge, DICTIONARIES_SAVE_PATH, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ scope: SCOPE, id, ops: [] }) });
    expect(crossSite.status).toBe(403);
    const noScope = await rawRequest(bridge, `${DICTIONARIES_PATH}?scope=..%2F..`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(JSON.parse(noScope.body)).toMatchObject({ ok: false, error: "invalid_scope" });
  });
});
