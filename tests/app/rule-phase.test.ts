// apply_rule の phase（行の時期で値を選ぶ。作業指示などのステータス）と、接続先ごとの過去の作業のステータスの試験。

import { describe, expect, it } from "vitest";
import { createStatusPrefs, DEFAULT_PAST_STATUS, PAST_STATUS_STORAGE_KEY, pastStatusOf, setPastStatus } from "../../src/app/maximo/statusPrefs";
import { StoreError } from "../../src/app/store/errors";
import { Workspace } from "../../src/app/store/workspace";
import type { CellValue, ColumnSchema, RuleValue } from "../../src/shared/model";
import { makeParentKey, type SheetMeta } from "../../src/shared/sheet";
import { TOOL_DEFS } from "../../src/shared/toolDefs";

const WO = "wo";
const NOW = Date.UTC(2023, 10, 14, 3, 0, 0);
const COLUMNS: ColumnSchema[] = [
  { name: "SITEID", type: "string" },
  { name: "WONUM", type: "string" },
  { name: "DESCRIPTION", type: "string" },
  { name: "STATUS", type: "string" },
  { name: "ACTSTART", type: "datetime" },
  { name: "ACTFINISH", type: "datetime" },
];
const meta = (): SheetMeta => ({
  name: WO,
  source: { kind: "maximo", os: "MXAPIWO", select: ["*"], where: [] },
  columns: COLUMNS,
  keyColumns: ["SITEID", "WONUM"],
  childIdAttrs: {},
});
const pk = (wonum: string) => makeParentKey(["BEDFORD", wonum]);
const wo = (wonum: string, actstart: string | null, actfinish: string | null, status: string | null = null): Record<string, CellValue> => ({
  SITEID: "BEDFORD",
  WONUM: wonum,
  DESCRIPTION: `${wonum} の作業`,
  STATUS: status,
  ACTSTART: actstart,
  ACTFINISH: actfinish,
});

/** 今ある WO1（完了済み）と、足した行: 過去 2・仕掛かり 1・先 1・日付なし 1 */
function setup(): Workspace {
  const ws = new Workspace("test", { now: () => NOW });
  ws.createSheet(meta(), [{ rowKey: pk("WO1"), parentKey: pk("WO1"), childName: null, values: wo("WO1", "2025-02-01T09:00:00+09:00", "2025-03-01T17:00:00+09:00", "COMP") }]);
  ws.addRows(
    WO,
    [
      wo("WO10", "2026-09-29T09:00:00+09:00", "2026-09-30T17:00:00+09:00"),
      wo("WO11", "2026-10-01T09:00:00+09:00", "2026-10-20T17:00:00+09:00"),
      wo("WO12", "2026-11-01T09:00:00+09:00", null),
      wo("WO13", null, null),
      wo("WO14", null, "2026-10-06T23:00:00+09:00"),
    ],
    { author: "llm", reason: "履歴を足す" },
  );
  return ws;
}

const PHASE: RuleValue = { phase: { finish: "ACTFINISH", start: "ACTSTART", past: "COMP", inProgress: "INPRG", future: "WAPPR", asOf: "2026-10-06" } };
const statusOf = (ws: Workspace, wonum: string) => ws.cell(WO, pk(wonum), "STATUS")?.value;

describe("apply_rule の phase", () => {
  it("終わりの日が asOf 以前なら past、始まりの日が asOf 以前なら inProgress、日付があれば future、日付が無ければ変えない。今ある行は変えない", () => {
    const ws = setup();
    const r = ws.applyRule(WO, [], { STATUS: PHASE }, { author: "llm", reason: "時期でステータスを決める" });
    expect(r.phase).toEqual({ STATUS: { past: 2, inProgress: 1, future: 1, noDate: 1, existing: 1, asOf: "2026-10-06" } });
    expect(r.applied).toBe(4);
    expect(["WO1", "WO10", "WO11", "WO12", "WO13", "WO14"].map((w) => statusOf(ws, w))).toEqual(["COMP", "COMP", "INPRG", "WAPPR", null, "COMP"]);
    expect(ws.cell(WO, pk("WO10"), "STATUS")?.reason).toBe("時期でステータスを決める");
  });

  it("newRowsOnly: false なら今ある行も時期で選ぶ（同じ値なら変えない）", () => {
    const ws = setup();
    ws.applyEdits(WO, [{ rowKey: pk("WO1"), col: "STATUS", value: "INPRG" }], { author: "user" });
    const r = ws.applyRule(WO, [{ attr: "WONUM", op: "eq", value: "WO1" }], { STATUS: { phase: { ...(PHASE as { phase: object }).phase, newRowsOnly: false } as never } }, { author: "llm" });
    expect(r.phase!.STATUS).toMatchObject({ past: 1, existing: 0 });
    expect(statusOf(ws, "WO1")).toBe("COMP");
  });

  it("asOf を省くと今日（この PC の日付）。dryRun は内訳だけ返して変えない", () => {
    const ws = setup();
    const d = new Date(NOW);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const { asOf: _drop, ...rest } = (PHASE as { phase: Record<string, unknown> }).phase;
    const r = ws.applyRule(WO, [], { STATUS: { phase: rest } as RuleValue }, { author: "llm", dryRun: true });
    // 2023-11 から見ると、足した行の日付はすべて先
    expect(r.phase!.STATUS).toEqual({ past: 0, inProgress: 0, future: 4, noDate: 1, existing: 1, asOf: today });
    expect(r.batchId).toBeNull();
    expect(statusOf(ws, "WO10")).toBeNull();
  });

  it("日付の列が無い・知らない列・past が無い・asOf が日付でない、は invalid_args か column_not_found", () => {
    const ws = setup();
    const codeOf = (rv: unknown) => {
      try {
        ws.applyRule(WO, [], { STATUS: rv as RuleValue }, { author: "llm" });
      } catch (e) {
        expect(e).toBeInstanceOf(StoreError);
        return (e as StoreError).code;
      }
      return null;
    };
    expect(codeOf({ phase: { past: "COMP", inProgress: "INPRG", future: "WAPPR" } })).toBe("invalid_args");
    expect(codeOf({ phase: { finish: "NOPE", past: "COMP", inProgress: "INPRG", future: "WAPPR" } })).toBe("column_not_found");
    expect(codeOf({ phase: { finish: "ACTFINISH", inProgress: "INPRG", future: "WAPPR" } })).toBe("invalid_args");
    expect(codeOf({ phase: { finish: "ACTFINISH", past: "COMP", inProgress: "INPRG", future: "WAPPR", asOf: "2026/10/06" } })).toBe("invalid_args");
  });

  it("ツールの引数: past は省ける。inProgress と future は要る", () => {
    const schema = TOOL_DEFS.apply_rule.inputSchema;
    const base = { sheet: WO, baseRevision: 0, reason: "r" };
    expect(schema.safeParse({ ...base, set: { STATUS: { phase: { finish: "ACTFINISH", inProgress: "INPRG", future: "WAPPR" } } } }).success).toBe(true);
    expect(schema.safeParse({ ...base, set: { STATUS: { phase: { finish: "ACTFINISH", inProgress: "INPRG" } } } }).success).toBe(false);
    expect(schema.safeParse({ ...base, set: { STATUS: { phase: { finish: "ACTFINISH", inProgress: "INPRG", future: "WAPPR", asOf: "today" } } } }).success).toBe(false);
  });
});

describe("過去の作業のステータス（接続先ごと）", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  it("選んでいなければ COMP。接続先ごとに覚え、URL の書き方の違いは同じ接続先として扱う", () => {
    const s = memory();
    expect(DEFAULT_PAST_STATUS).toBe("COMP");
    expect(pastStatusOf(s, "https://mx.example.com/maximo")).toBe("COMP");
    setPastStatus(s, "https://mx.example.com/maximo/", "CLOSE");
    expect(pastStatusOf(s, "https://MX.example.com/maximo")).toBe("CLOSE");
    expect(pastStatusOf(s, "https://other.example.com/maximo")).toBe("COMP");
    expect(createStatusPrefs(s).pastStatusOf("https://mx.example.com/maximo")).toBe("CLOSE");
  });

  it("壊れた値・知らない値・ストレージが無いときは COMP", () => {
    const s = memory();
    s.setItem(PAST_STATUS_STORAGE_KEY, "{");
    expect(pastStatusOf(s, "https://mx.example.com/maximo")).toBe("COMP");
    s.setItem(PAST_STATUS_STORAGE_KEY, JSON.stringify({ "https://mx.example.com/maximo": "CAN" }));
    expect(pastStatusOf(s, "https://mx.example.com/maximo")).toBe("COMP");
    expect(pastStatusOf(null, "https://mx.example.com/maximo")).toBe("COMP");
    expect(() => setPastStatus(null, "https://mx.example.com/maximo", "CLOSE")).not.toThrow();
  });
});
