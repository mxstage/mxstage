// 画面の純ロジック（ルート解決・状態の文言・設定フォームの検査・セルの色分け・反映パネル）の試験。
import { describe, expect, it } from "vitest";
import type { CommitRowResult } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey } from "../../src/shared/sheet";
import { toMaximoError, MaximoNetworkError } from "../../src/app/maximo/client";
import type { RelayStatus } from "../../src/app/relay";
import type { CommitPanelState } from "../../src/app/runtime/contracts";
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { cellTone, formatCellValue, hoverLines, isCellEditable, parseEditedText } from "../../src/app/grid/cellStyle";
import { conflictSummary } from "../../src/app/grid/edits";
import { clampSelection, isReclickOnSelected, singleSelectedCell } from "../../src/app/grid/selection";
import {
  canCancelCommit,
  canConfirmCommit,
  commitButtonState,
  countResults,
  displayRowKey,
  resultSummary,
  runOutcomeMessage,
  totalChanges,
  withBom,
  writeLogFileName,
} from "../../src/app/pages/commitLogic";
import { connectionIndicator, maximoBadge, relayBadge, REOPEN_HINT_AFTER, reopenHint, shouldSuggestReopen } from "../../src/app/pages/status";
import { rowCountLabel } from "../../src/app/grid/filters";
import {
  connectErrorMessage,
  loadSavedSettings,
  normalizeBaseUrl,
  parseSkillList,
  proxyErrorCode,
  proxyRejectMessage,
  saveSettings,
  STORAGE_KEYS,
  validateSettingsForm,
} from "../../src/app/settings/logic";
import { isPlainLeftClick, resolveRoute } from "../../src/app/ui/routes";

const relay = (patch: Partial<RelayStatus> = {}): RelayStatus => ({
  state: "open",
  tabId: "tab-1",
  role: "primary",
  primaryTabId: "tab-1",
  heartbeatMs: 20_000,
  attempt: 0,
  nextRetryMs: null,
  lastCloseCode: null,
  ...patch,
});

const panelOf = (patch: Partial<CommitPanelState> = {}): CommitPanelState => ({
  sheet: "許可申請",
  state: "idle",
  counts: { parents: 3, changedCells: 5, addedRows: 0, deletedRows: 0 },
  blockers: [],
  needsDeleteConfirm: false,
  needsNullConfirm: false,
  awaitingCanary: null,
  results: [],
  ...patch,
});

describe("ルート解決", () => {
  it("/app と /settings を見分け、それ以外は作業画面へ送る", () => {
    expect(resolveRoute("/app")).toEqual({ kind: "app" });
    expect(resolveRoute("/app/")).toEqual({ kind: "app" });
    expect(resolveRoute("/settings")).toEqual({ kind: "settings" });
    expect(resolveRoute("/settings/")).toEqual({ kind: "settings" });
    expect(resolveRoute("/")).toEqual({ kind: "redirect", to: "/app" });
    expect(resolveRoute("/nothing")).toEqual({ kind: "redirect", to: "/app" });
  });

  it("修飾キー付きのクリックは画面内の遷移にしない", () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
    expect(isPlainLeftClick(base)).toBe(true);
    expect(isPlainLeftClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...base, defaultPrevented: true })).toBe(false);
  });
});

describe("上部バーの文言", () => {
  it("中継の状態ごとの表示", () => {
    expect(relayBadge(relay()).text).toBe("中継: primary");
    expect(relayBadge(relay({ role: "mirror" })).text).toBe("中継: ミラー");
    expect(relayBadge(relay({ state: "connecting", role: null })).text).toBe("中継: 接続中");
    expect(relayBadge(relay({ state: "reconnecting", role: null, nextRetryMs: 4_200 })).text).toBe("中継: 再接続中（5 秒後）");
    expect(relayBadge(relay({ state: "reconnecting", role: null, nextRetryMs: 8_000 }), 1_200).text).toBe("中継: 再接続中（2 秒後）");
    const mismatch = relayBadge(relay({ state: "protocol_mismatch", role: null }));
    expect(mismatch.text).toBe("中継: 版違い");
    expect(mismatch.showReload).toBe(true);
    expect(relayBadge(null).tone).toBe("muted");
  });

  it("再接続が続いたら作業画面を開き直す案内を出す（一瞬の切断では出さない）", () => {
    expect(REOPEN_HINT_AFTER).toBeGreaterThanOrEqual(5);
    for (let attempt = 0; attempt < REOPEN_HINT_AFTER; attempt++) {
      expect(shouldSuggestReopen(relay({ state: "reconnecting", attempt }))).toBe(false);
    }
    for (const attempt of [REOPEN_HINT_AFTER, REOPEN_HINT_AFTER + 1, REOPEN_HINT_AFTER + 20]) {
      expect(shouldSuggestReopen(relay({ state: "reconnecting", attempt }))).toBe(true);
    }
    // つながっている間・接続中・停止中は出さない（案内は再接続中だけ）
    expect(shouldSuggestReopen(relay({ state: "open", attempt: 99 }))).toBe(false);
    expect(shouldSuggestReopen(relay({ state: "connecting", role: null, attempt: 99 }))).toBe(false);
    expect(shouldSuggestReopen(relay({ state: "closed", role: null, attempt: 99 }))).toBe(false);
  });

  it("再接続の案内は、開き直しを勧めない（作業データと API キーはタブのメモリにしか無い）", () => {
    const hint = reopenHint();
    // 中継は自動で再接続し続けるので、橋渡しが動き出せばこのタブのままつながる
    expect(hint.title).toContain("自動でつなぎ直します");
    expect(hint.title).toContain("閉じたり再読み込みしたりしないでください");
    // 「開き直せ」と「データは残る」を同時に言わない（開き直すと消える）
    expect(hint.title).not.toContain("開き直");
    expect(hint.title).not.toContain("残ります");
    expect(`${hint.text}${hint.title}`).not.toContain("秘密リンク");
  });

  it("Maximo の接続状態", () => {
    expect(maximoBadge({ kind: "disconnected" })).toEqual({ text: "Maximo: 未接続", tone: "muted", settingsLink: "設定で接続" });
    const info = { baseUrl: "https://maximo.test", via: "proxy" as const, connectionName: "MAXADMIN@dev", userName: "MAXADMIN", connectedAt: 0 };
    expect(maximoBadge({ kind: "connected", info }).text).toBe("Maximo: MAXADMIN@dev（maximo.test / MAXADMIN）");
    const locked = maximoBadge({ kind: "locked", info, reason: "idle" });
    expect(locked.text).toBe("Maximo: ロック中");
    expect(locked.settingsLink).toBe("設定で再接続");
  });

  it("接続の ○ は中継と Maximo のうち悪いほうの色にし、文言は title にまとめる", () => {
    const info = { baseUrl: "https://maximo.test", via: "proxy" as const, connectionName: "MAXADMIN@dev", userName: "MAXADMIN", connectedAt: 0 };
    const connected = maximoBadge({ kind: "connected", info });
    const ok = connectionIndicator(relayBadge(relay()), connected, "作業1");
    expect(ok.tone).toBe("ok");
    expect(ok.label).toBe("中継: primary／Maximo: MAXADMIN@dev（maximo.test / MAXADMIN）");
    expect(ok.title).toContain("作業: 作業1");
    expect(ok.title).toContain("中継: primary（LLM のツールはこのタブで実行されます。）");
    expect(ok.title).toContain("Maximo: MAXADMIN@dev");
    // Maximo が未接続なら、中継がつながっていても ok にしない
    expect(connectionIndicator(relayBadge(relay()), maximoBadge({ kind: "disconnected" }), "作業1").tone).toBe("muted");
    // 悪いほう: error > warn > muted > ok
    expect(connectionIndicator(relayBadge(relay({ role: "mirror" })), maximoBadge({ kind: "disconnected" }), "作業1").tone).toBe("warn");
    expect(connectionIndicator(relayBadge(relay({ state: "protocol_mismatch", role: null })), maximoBadge({ kind: "locked", info, reason: "idle" }), "作業1").tone).toBe("error");
  });
});

describe("ペインの行数", () => {
  it("絞り込みか連動で減っていれば「残り / 全体」、どちらも無ければ「全体 行」", () => {
    expect(rowCountLabel({ shown: 120, total: 120, narrowed: false })).toBe("120 行");
    expect(rowCountLabel({ shown: 12, total: 120, narrowed: true })).toBe("12 / 120");
    // 連動していて全部が当たっても、連動中であることが分かるように分数で出す
    expect(rowCountLabel({ shown: 12, total: 12, narrowed: true })).toBe("12 / 12");
  });
});

describe("設定フォームの検査", () => {
  const ok = { baseUrl: "https://maximo.example.com", via: "proxy", connectionName: "MAXADMIN@mas-dev", apiKey: "abc123" };

  it("正しい入力ならエラーなし", () => {
    expect(validateSettingsForm(ok)).toEqual({});
    expect(normalizeBaseUrl("  https://maximo.example.com/  ")).toBe("https://maximo.example.com");
  });

  it("URL・接続名・API キーの誤りを指摘する", () => {
    expect(validateSettingsForm({ ...ok, baseUrl: "" }).baseUrl).toContain("入力");
    expect(validateSettingsForm({ ...ok, baseUrl: "maximo" }).baseUrl).toContain("形式");
    expect(validateSettingsForm({ ...ok, baseUrl: "http://maximo.example.com" }).baseUrl).toContain("https");
    expect(validateSettingsForm({ ...ok, baseUrl: "https://maximo.example.com/maximo" }).baseUrl).toContain("パス");
    expect(validateSettingsForm({ ...ok, via: "direct", baseUrl: "https://maximo.example.com/maximo" }).baseUrl).toBeUndefined();
    expect(validateSettingsForm({ ...ok, via: "direct", baseUrl: "http://localhost:9080" }).baseUrl).toBeUndefined();
    expect(validateSettingsForm({ ...ok, via: "unknown" }).via).toContain("接続方式");
    expect(validateSettingsForm({ ...ok, connectionName: "  " }).connectionName).toContain("接続名");
    expect(validateSettingsForm({ ...ok, apiKey: "" }).apiKey).toContain("入力");
    expect(validateSettingsForm({ ...ok, apiKey: "ab cd" }).apiKey).toContain("使えない文字");
    expect(validateSettingsForm({ ...ok, apiKey: "キー" }).apiKey).toContain("使えない文字");
  });
});

describe("接続の失敗の文言", () => {
  const proxyError = (status: number, error: string) => toMaximoError(status, { ok: false, error, message: "だめでした。" });

  it("橋渡しの 403（許可ホスト外）は、橋渡しの --allow-host を案内する", () => {
    expect(proxyErrorCode(proxyError(403, "host_not_allowed").message)).toBe("host_not_allowed");
    const message = connectErrorMessage(proxyError(403, "host_not_allowed"), "proxy");
    expect(message).toContain("許可されていません");
    expect(message).toContain("--allow-host");
    expect(message).not.toContain("API キーが無効");
  });

  it("キーの誤りと到達できない場合", () => {
    expect(connectErrorMessage(toMaximoError(401, { Error: { reasonCode: "BMXAA0021E", message: "invalid" } }), "proxy")).toContain("API キーが無効");
    expect(connectErrorMessage(proxyError(502, "upstream_unreachable"), "proxy")).toContain("直結");
    expect(connectErrorMessage(toMaximoError(526, null), "proxy")).toContain("直結");
    expect(connectErrorMessage(toMaximoError(404, null), "proxy")).toContain("whoami");
    expect(connectErrorMessage(toMaximoError(200, null), "proxy")).toContain("JSON");
  });

  it("直結方式で届かないときは CORS を案内する", () => {
    expect(connectErrorMessage(new MaximoNetworkError("x", false), "direct")).toContain("CORS");
    expect(connectErrorMessage(new MaximoNetworkError("x", true), "direct")).toContain("タイムアウト");
    expect(connectErrorMessage(new MaximoNetworkError("x", false), "proxy")).toContain("接続できませんでした");
  });

  it("橋渡しが受け付けないときとロック", () => {
    expect(connectErrorMessage(proxyError(401, "unauthorized"), "proxy")).toContain("橋渡しを起動し直して");
    expect(connectErrorMessage(proxyError(423, "vault_locked"), "proxy")).toContain("ロック");
  });

  it("橋渡しの /mx が断ったときは、コードごとの案内を出す（403 でも「API キーが無効」とは言わない）", () => {
    const local = (status: number, code: string) => connectErrorMessage(proxyError(status, code), "proxy");

    const pathNotAllowed = local(403, "path_not_allowed");
    expect(pathNotAllowed).not.toContain("API キーが無効");
    expect(pathNotAllowed).toContain("/maximo/api/");
    expect(pathNotAllowed).toContain("API キーの誤りではありません");
    expect(pathNotAllowed).toContain("橋渡し");
    expect(pathNotAllowed).toContain("導入をやり直して");

    expect(local(400, "missing_apikey")).toContain("API キーを入れ直して");
    expect(local(400, "missing_apikey")).toContain("橋渡し");

    const inQuery = local(400, "apikey_in_query");
    expect(inQuery).toContain("クエリ");
    expect(inQuery).toContain("転送を止めました");

    const invalidPath = local(400, "invalid_path");
    expect(invalidPath).toContain("使えない文字");
    expect(invalidPath).toContain("API キーの誤りではありません");

    const method = local(405, "method_not_allowed");
    expect(method).toContain("GET と POST");
    expect(method).not.toContain("HTTP 405");

    const timeout = local(504, "upstream_timeout");
    expect(timeout).toContain("時間内に返りませんでした");
    expect(timeout).toContain("橋渡し");
    expect(timeout).toContain("VPN");
  });

  it("proxyRejectMessage: 知らないコードは null（ほかの判定に回す）", () => {
    expect(proxyRejectMessage(null)).toBeNull();
    expect(proxyRejectMessage("host_not_allowed")).toBeNull();
    expect(proxyRejectMessage("upstream_unreachable")).toBeNull();
    for (const code of ["path_not_allowed", "missing_apikey", "apikey_in_query", "invalid_path", "method_not_allowed", "upstream_timeout"]) {
      expect(proxyRejectMessage(code)).toEqual(expect.any(String));
    }
    // コードの無い 403（Maximo そのものの応答）は、これまでどおりキーか権限の問題として案内する
    expect(connectErrorMessage(toMaximoError(403, { Error: { reasonCode: "BMXAA9051E", message: "forbidden" } }), "proxy")).toContain("API キーが無効");
    // Cloudflare 版は無いので、その名前を出さない
    expect(proxyRejectMessage("upstream_timeout")).not.toContain("Cloudflare");
  });
});

describe("保存する設定", () => {
  it("localStorage に URL と接続方式だけを保存する", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    saveSettings(storage, { baseUrl: "https://maximo.test", via: "direct" });
    expect(map.get(STORAGE_KEYS.baseUrl)).toBe("https://maximo.test");
    expect(loadSavedSettings(storage)).toEqual({ baseUrl: "https://maximo.test", via: "direct" });
    expect([...map.values()].join(",")).not.toContain("apiKey");
  });

  it("使えない localStorage でも既定値を返す", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSavedSettings(broken)).toEqual({ baseUrl: "", via: "proxy" });
    expect(() => saveSettings(broken, { baseUrl: "x", via: "proxy" })).not.toThrow();
    expect(loadSavedSettings(null)).toEqual({ baseUrl: "", via: "proxy" });
  });
});

describe("Skill の一覧（橋渡しの /_mxstudio/skills）", () => {
  it("アプリ既定と利用者の Skill を出どころ付きで読み、形の合わない項目は捨てる", () => {
    const list = parseSkillList({
      userSkillsDir: "/home/u/.config/mxstudio/skills",
      skills: [
        { name: "mxstudio-workbench", version: "0.7.0", description: "基本手順", origin: "default" },
        { name: "my-flow", version: "0.1.0", description: "業務の手順", origin: "user" },
        { name: "Bad Name", origin: "user" },
        { name: "no-origin" },
        "x",
      ],
      problems: [{ name: "broken", level: "error", message: "SKILL.md がありません。" }, { name: "w", level: "warn", message: "注意" }, { name: "n" }],
    });
    expect(list.skills.map((s) => [s.name, s.origin])).toEqual([
      ["mxstudio-workbench", "default"],
      ["my-flow", "user"],
    ]);
    expect(list.problems).toEqual([
      { name: "broken", level: "error", message: "SKILL.md がありません。" },
      { name: "w", level: "warn", message: "注意" },
    ]);
    expect(list.userSkillsDir).toBe("/home/u/.config/mxstudio/skills");
  });

  it("壊れた応答でも空の一覧にする", () => {
    expect(parseSkillList(null)).toEqual({ skills: [], problems: [], userSkillsDir: null });
  });
});

describe("セルの色分け", () => {
  const base = { view: "final" as const, rowStatus: "base" as const, changed: false, author: null, protectedColumn: false };

  it("作者と行の状態で色を分ける", () => {
    expect(cellTone(base)).toBe("normal");
    expect(cellTone({ ...base, protectedColumn: true })).toBe("readonly");
    expect(cellTone({ ...base, rowStatus: "changed", changed: true, author: "llm" })).toBe("llm");
    expect(cellTone({ ...base, rowStatus: "changed", changed: true, author: "user" })).toBe("user");
    expect(cellTone({ ...base, rowStatus: "added", author: "llm" })).toBe("added");
    expect(cellTone({ ...base, view: "diff", rowStatus: "deleted", author: "user" })).toBe("deleted");
    // 元の値ビューでは変更を色付けしない
    expect(cellTone({ ...base, view: "base", rowStatus: "changed", changed: true, author: "llm" })).toBe("normal");
    expect(cellTone({ ...base, view: "base", rowStatus: "changed", changed: true, author: "llm", protectedColumn: true })).toBe("readonly");
  });

  it("編集できるのは最終ビューの変更できるセルだけ", () => {
    expect(isCellEditable({ view: "final", rowStatus: "base", protectedColumn: false, busy: false })).toBe(true);
    expect(isCellEditable({ view: "diff", rowStatus: "changed", protectedColumn: false, busy: false })).toBe(false);
    expect(isCellEditable({ view: "base", rowStatus: "base", protectedColumn: false, busy: false })).toBe(false);
    expect(isCellEditable({ view: "final", rowStatus: "base", protectedColumn: true, busy: false })).toBe(false);
    expect(isCellEditable({ view: "final", rowStatus: "base", protectedColumn: false, busy: true })).toBe(false);
    expect(isCellEditable({ view: "final", rowStatus: "deleted", protectedColumn: false, busy: false })).toBe(false);
  });

  it("ホバーに作者・根拠・変更前後を出す", () => {
    expect(hoverLines({ tone: "llm", author: "llm", reason: "DESCRIPTION から判断", before: "A", after: "B" })).toEqual(["作者: LLM", "根拠: DESCRIPTION から判断", "A → B"]);
    expect(hoverLines({ tone: "user", author: "user", reason: null, before: null, after: "X" })).toEqual(["作者: 利用者", "（空） → X"]);
    expect(hoverLines({ tone: "deleted", author: "llm", reason: "重複", before: "A", after: "A" })).toEqual(["削除行", "作者: LLM", "根拠: 重複"]);
    expect(hoverLines({ tone: "added", author: "llm", reason: null, before: null, after: "A" })).toEqual(["追加行", "作者: LLM"]);
    expect(hoverLines({ tone: "readonly", author: null, reason: null, before: "A", after: "A" })).toEqual(["読み取り専用の列（キー列など）"]);
    expect(hoverLines({ tone: "normal", author: null, reason: null, before: "A", after: "A" })).toBeNull();
  });

  it("空欄は null にする", () => {
    expect(parseEditedText("")).toBeNull();
    expect(parseEditedText("2026-09-30")).toBe("2026-09-30");
    expect(formatCellValue(null)).toBe("");
    expect(formatCellValue(12)).toBe("12");
  });
});

describe("グリッドの選択範囲", () => {
  const sel = (patch: Partial<GridSelection> = {}): GridSelection => ({ columns: CompactSelection.empty(), rows: CompactSelection.empty(), ...patch });

  it("行が減ったら範囲外の選択を切り詰める", () => {
    const selection = sel({
      rows: CompactSelection.fromSingleSelection([2, 8]),
      current: { cell: [1, 3], range: { x: 1, y: 3, width: 2, height: 4 }, rangeStack: [{ x: 0, y: 6, width: 1, height: 2 }] },
    });
    // 8 行あったシートが 5 行になった
    const clamped = clampSelection(selection, 5, 3);
    expect(clamped.rows.toArray()).toEqual([2, 3, 4]);
    expect(clamped.current?.range).toEqual({ x: 1, y: 3, width: 2, height: 2 });
    // 範囲外になった 6 行目以降の選択は消える
    expect(clamped.current?.rangeStack).toEqual([]);
  });

  it("選んでいた 1 マスをもう一度押したら選択を外す（範囲の選択や、Shift・Ctrl・ダブルクリックは除く）", () => {
    const one = sel({ current: { cell: [2, 4], range: { x: 2, y: 4, width: 1, height: 1 }, rangeStack: [] } });
    const before = singleSelectedCell(one);
    expect(before).toEqual([2, 4]);
    const click = { before, cell: [2, 4] as const, shiftKey: false, ctrlKey: false, metaKey: false, button: 0, isDoubleClick: false };
    expect(isReclickOnSelected(click)).toBe(true);
    // 別のセル・範囲を広げる操作・ダブルクリック（編集を開く）・右ボタンでは外さない
    expect(isReclickOnSelected({ ...click, cell: [2, 5] })).toBe(false);
    expect(isReclickOnSelected({ ...click, shiftKey: true })).toBe(false);
    expect(isReclickOnSelected({ ...click, ctrlKey: true })).toBe(false);
    expect(isReclickOnSelected({ ...click, isDoubleClick: true })).toBe(false);
    expect(isReclickOnSelected({ ...click, button: 2 })).toBe(false);
    // 押す前に何も選んでいない・範囲を選んでいたときは、押しても外さない（選ぶだけ）
    expect(isReclickOnSelected({ ...click, before: null })).toBe(false);
    expect(singleSelectedCell(sel())).toBeNull();
    expect(singleSelectedCell(sel({ current: { cell: [2, 4], range: { x: 2, y: 4, width: 2, height: 1 }, rangeStack: [] } }))).toBeNull();
    expect(singleSelectedCell(sel({ current: { cell: [2, 4], range: { x: 2, y: 4, width: 1, height: 1 }, rangeStack: [{ x: 0, y: 0, width: 1, height: 1 }] } }))).toBeNull();
  });

  it("選択中のセルが消えたら選択を外す", () => {
    const selection = sel({ current: { cell: [0, 7], range: { x: 0, y: 7, width: 1, height: 1 }, rangeStack: [] } });
    expect(clampSelection(selection, 5, 3).current).toBeUndefined();
    // 列が減った場合も同じ
    const byColumn = sel({ current: { cell: [4, 0], range: { x: 4, y: 0, width: 1, height: 1 }, rangeStack: [] } });
    expect(clampSelection(byColumn, 5, 3).current).toBeUndefined();
  });

  it("列の選択も切り詰め、範囲内なら同じものを返す", () => {
    const columns = sel({ columns: CompactSelection.fromSingleSelection([0, 5]) });
    expect(clampSelection(columns, 5, 3).columns.toArray()).toEqual([0, 1, 2]);

    const inside = sel({ rows: CompactSelection.fromSingleSelection(1), current: { cell: [0, 1], range: { x: 0, y: 1, width: 1, height: 1 }, rangeStack: [] } });
    expect(clampSelection(inside, 5, 3)).toBe(inside);
    // 行が 0 件になったら何も選択しない
    const empty = clampSelection(inside, 0, 3);
    expect(empty.rows.length).toBe(0);
    expect(empty.current).toBeUndefined();
  });
});

describe("変更できなかったセルの要約", () => {
  it("理由ごとに数える", () => {
    expect(conflictSummary([])).toBeNull();
    const msg = conflictSummary([
      { rowKey: "a", col: "X", reason: "read_only_column" },
      { rowKey: "b", col: "X", reason: "read_only_column" },
      { rowKey: "c", col: "Y", reason: "invalid_value" },
    ]);
    expect(msg).toBe("3 件のセルは変更できませんでした（読み取り専用の列 2 件、値が列の型に合わない 1 件）。");
    expect(conflictSummary([{ rowKey: "a", col: "X", reason: "user_editing" }], "取り消し")).toContain("取り消しできませんでした");
  });
});

describe("反映パネル", () => {
  it("押せる条件", () => {
    expect(commitButtonState(panelOf(), { connected: true })).toEqual({ enabled: true, reason: null });
    expect(commitButtonState(null, { connected: true }).enabled).toBe(false);
    expect(commitButtonState(panelOf(), { connected: false }).reason).toContain("接続していません");
    expect(commitButtonState(panelOf(), { connected: false, locked: true }).reason).toContain("ロック");
    expect(commitButtonState(panelOf({ state: "running" }), { connected: true }).reason).toContain("反映中");
    expect(commitButtonState(panelOf({ blockers: ["href がありません"] }), { connected: true }).enabled).toBe(false);
    expect(commitButtonState(panelOf({ counts: { parents: 0, changedCells: 0, addedRows: 0, deletedRows: 0 } }), { connected: true }).reason).toContain("変更がありません");
    expect(commitButtonState(panelOf({ awaitingCanary: { rowKey: "a", status: "verified" } }), { connected: true }).reason).toContain("最初の 1 件");
  });

  it("削除と null への変更は確認が要る", () => {
    const p = panelOf({ needsDeleteConfirm: true, needsNullConfirm: true, counts: { parents: 1, changedCells: 1, addedRows: 0, deletedRows: 12 } });
    expect(canConfirmCommit(p, { deletes: false, nulls: false })).toBe(false);
    expect(canConfirmCommit(p, { deletes: true, nulls: false })).toBe(false);
    expect(canConfirmCommit(p, { deletes: true, nulls: true })).toBe(true);
    expect(canConfirmCommit(panelOf(), { deletes: false, nulls: false })).toBe(true);
    expect(totalChanges(p.counts)).toBe(13);
  });

  it("結果の集計と表示", () => {
    const results: CommitRowResult[] = [
      { rowKey: "a", status: "verified" },
      { rowKey: "b", status: "verified" },
      { rowKey: "c", status: "error", httpStatus: 400, reasonCode: "BMXAA0001E" },
    ];
    expect(countResults(results).verified).toBe(2);
    expect(resultSummary(results)).toBe("反映済み 2 件、エラー 1 件");
    expect(resultSummary([])).toBe("");
  });

  it("行キーを読める形にする", () => {
    const parent = makeParentKey(["BEDFORD", "WO062041"]);
    expect(displayRowKey(parent)).toBe("BEDFORD / WO062041");
    expect(displayRowKey(makeChildRowKey(parent, "EXT_WOPERMIT", 12))).toBe("BEDFORD / WO062041 #EXT_WOPERMIT:12");
  });

  it("[反映を中止] は実行中とカナリアの確認待ちだけに出す", () => {
    expect(canCancelCommit(null)).toBe(false);
    expect(canCancelCommit(panelOf())).toBe(false);
    expect(canCancelCommit(panelOf({ state: "requested" }))).toBe(false);
    expect(canCancelCommit(panelOf({ state: "running" }))).toBe(true);
    // カナリアの確認待ち（controller は running のままだが、状態が食い違っても出す）
    expect(canCancelCommit(panelOf({ state: "running", awaitingCanary: { rowKey: "a", status: "conflict" } }))).toBe(true);
    expect(canCancelCommit(panelOf({ state: "failed", awaitingCanary: { rowKey: "a", status: "conflict" } }))).toBe(true);
    // 終わった後は取り消せないので出さない
    expect(canCancelCommit(panelOf({ state: "done", results: [{ rowKey: "a", status: "verified" }] }))).toBe(false);
    expect(canCancelCommit(panelOf({ state: "failed" }))).toBe(false);
  });

  it("run の後の文言は controller の理由（message）を優先する", () => {
    const opts = { connected: true };
    // 1 件も送らなかったとき: message があればそれ、無ければボタンの条件から推測する
    expect(runOutcomeMessage(panelOf({ state: "idle", message: "反映中に別の変更が入りました" }), opts)).toEqual({
      text: "反映しませんでした: 反映中に別の変更が入りました",
      tone: "error",
    });
    expect(runOutcomeMessage(panelOf({ state: "idle", blockers: ["href がありません"] }), opts)).toEqual({
      text: "反映しませんでした: 反映できない理由があります。",
      tone: "error",
    });
    expect(runOutcomeMessage(panelOf({ state: "idle" }), opts).text).toBe("反映しませんでした。");
    // 空の message は理由として使わない
    expect(runOutcomeMessage(panelOf({ state: "idle", message: "", blockers: ["href がありません"] }), opts).text).toContain("反映できない理由");
    // すでに反映中
    expect(runOutcomeMessage(panelOf({ state: "running" }), opts)).toEqual({ text: "すでに反映中です。", tone: "error" });
    expect(runOutcomeMessage(panelOf({ state: "running", message: "他のタブが反映しています" }), opts).text).toBe("他のタブが反映しています");
    // 送った後: 結果の要約に理由を添える
    const results: CommitRowResult[] = [
      { rowKey: "a", status: "verified" },
      { rowKey: "b", status: "skipped" },
    ];
    expect(runOutcomeMessage(panelOf({ state: "failed", results, message: "利用者が中止しました。" }), opts)).toEqual({
      text: "反映が終わりました（反映済み 1 件、未送信 1 件）。利用者が中止しました。",
      tone: "error",
    });
    expect(runOutcomeMessage(panelOf({ state: "done", results: [{ rowKey: "a", status: "verified" }] }), opts)).toEqual({
      text: "反映が終わりました（反映済み 1 件）。",
      tone: "info",
    });
  });

  it("ログのファイル名と BOM", () => {
    expect(writeLogFileName(new Date(2026, 8, 16, 10, 30, 5))).toBe("mxstudio-writelog-20260916-103005.csv");
    const csv = withBom("a,b\n1,2");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(withBom(csv)).toBe(csv);
  });
});
