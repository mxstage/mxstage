// Workspace の性質試験（fast-check）。
// ランダムな編集列を適用し、全バッチを逆順に取り消すと最終ビューが base に戻ることなどを確かめる。

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CellValue, ColumnSchema, RuleValue } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";
import { Workspace } from "../../src/app/store/workspace";

const S = "s";
const CH = "CH";
const V = `${CH}.V`;
const ID = `${CH}.ID`;

const COLUMNS: ColumnSchema[] = [
  { name: "K", type: "string" },
  { name: "P", type: "string" },
  { name: "N", type: "number" },
  { name: "R", type: "string", readOnly: true },
  { name: ID, type: "integer", child: CH },
  { name: V, type: "string", child: CH },
];
const ALL_COLS = COLUMNS.map((c) => c.name);

function makeWorkspace(): Workspace {
  const ws = new Workspace("prop", { now: () => 0 });
  const meta: SheetMeta = { name: S, source: { kind: "maximo", os: "OS", select: [], where: [] }, columns: COLUMNS, keyColumns: ["K"], childIdAttrs: { [CH]: "ID" } };
  const rows: SheetRow[] = [];
  let id = 1;
  for (const k of ["A", "B"]) {
    const pk = makeParentKey([k]);
    for (const v of ["x", "y"]) {
      const cid = id++;
      rows.push({ rowKey: makeChildRowKey(pk, CH, cid), parentKey: pk, childName: CH, values: { K: k, P: `p${k}`, N: cid, R: "r", [ID]: cid, [V]: v } });
    }
  }
  const pc = makeParentKey(["C"]);
  rows.push({ rowKey: pc, parentKey: pc, childName: null, values: { K: "C", P: "", N: null, R: "r", [ID]: null, [V]: null } });
  ws.createSheet(meta, rows);
  ws.createSheet(
    { name: "t", source: { kind: "maximo", os: "OS", select: [], where: [] }, columns: [{ name: "TK", type: "string" }, { name: "TV", type: "string" }], keyColumns: ["TK"], childIdAttrs: {} },
    [
      { rowKey: "pA", parentKey: "pA", childName: null, values: { TK: "pA", TV: "from-t" } },
      { rowKey: "x", parentKey: "x", childName: null, values: { TK: "x", TV: "tx" } },
    ],
  );
  return ws;
}

const valueArb: fc.Arbitrary<CellValue> = fc.constantFrom<CellValue>("x", "y", "z", "pA", "", null, 1, 2.5, "3", true);
const colArb = fc.constantFrom(...ALL_COLS);
const authorArb = fc.constantFrom<"user" | "llm">("user", "llm");

type Op =
  | { t: "edit"; author: "user" | "llm"; edits: Array<{ row: number; col: string; value: CellValue; reason: string | null }>; stale: boolean }
  | { t: "rule"; col: string; rule: "const" | "copy" | "lookup"; value: CellValue; filterVal: CellValue | null; dryRun: boolean }
  | { t: "addParent"; key: string; p: CellValue }
  | { t: "addChild"; row: number; v: CellValue }
  | { t: "delete"; rows: number[] }
  | { t: "undo"; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    t: fc.constant("edit" as const),
    author: authorArb,
    edits: fc.array(fc.record({ row: fc.nat(20), col: colArb, value: valueArb, reason: fc.option(fc.constantFrom("why", "根拠")) }), { minLength: 1, maxLength: 4 }),
    stale: fc.boolean(),
  }),
  fc.record({
    t: fc.constant("rule" as const),
    col: fc.constantFrom("P", "N", V),
    rule: fc.constantFrom("const" as const, "copy" as const, "lookup" as const),
    value: valueArb,
    filterVal: fc.option(fc.constantFrom("x", "y", "pA", "pB")),
    dryRun: fc.boolean(),
  }),
  fc.record({ t: fc.constant("addParent" as const), key: fc.constantFrom("A", "D", "E"), p: valueArb }),
  fc.record({ t: fc.constant("addChild" as const), row: fc.nat(20), v: valueArb }),
  fc.record({ t: fc.constant("delete" as const), rows: fc.array(fc.nat(20), { minLength: 1, maxLength: 2 }) }),
);

/** 途中で取り消しを挟む操作列（取り消せない部分が残る部分取り消しも起こる） */
const opWithUndoArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: opArb, weight: 4 },
  { arbitrary: fc.record({ t: fc.constant("undo" as const), pick: fc.nat(50) }), weight: 1 },
);

/** 操作を適用し、作られたバッチ ID を返す */
function applyOp(ws: Workspace, op: Op): string | null {
  const sheet = ws.getSheet(S);
  const pick = (i: number, view: "final" | "base" = "final"): string => {
    const keys = sheet.rowKeys(view);
    return keys.length === 0 ? "none" : (keys[i % keys.length] as string);
  };
  switch (op.t) {
    case "edit": {
      const edits = op.edits.map((e) => ({ rowKey: pick(e.row, e.row % 3 === 0 ? "base" : "final"), col: e.col, value: e.value, ...(e.reason ? { reason: e.reason } : {}) }));
      return ws.applyEdits(S, edits, { author: op.author, reason: "edit", baseRevision: op.stale ? Math.max(0, ws.revision - 1) : ws.revision }).batchId;
    }
    case "rule": {
      const rv: RuleValue =
        op.rule === "const"
          ? { const: op.value }
          : op.rule === "copy"
            ? { copyFrom: op.col === V ? "P" : V }
            : { lookup: { sheet: "t", matchCol: op.col === V ? "P" : V, targetMatchCol: "TK", sourceCol: "TV", normalize: ["trim"] } };
      const filter = op.filterVal === null ? [] : [{ attr: op.col === V ? "P" : V, op: "eq" as const, value: op.filterVal }];
      const before = ws.revision;
      const r = ws.applyRule(S, filter, { [op.col]: rv }, { author: "llm", reason: "rule", dryRun: op.dryRun });
      if (op.dryRun) {
        expect(r.batchId).toBeNull();
        expect(ws.revision).toBe(before);
      }
      return r.batchId;
    }
    case "addParent":
      return ws.addRows(S, [{ K: op.key, P: op.p }], { author: "llm", reason: "add" }).batchId;
    case "addChild":
      return ws.addRows(S, [{ [V]: op.v }], { author: "user", parentRowKey: pick(op.row) }).batchId;
    case "delete":
      return ws.deleteRows(S, op.rows.map((i) => pick(i)), { author: "llm", reason: "del" }).batchId;
    case "undo": {
      const open = ws.listBatches(S).filter((b) => !b.undone);
      const target = open[op.pick % Math.max(1, open.length)];
      if (target) ws.undoBatch(target.batchId, { author: "llm" });
      return null;
    }
  }
}

function snapshot(ws: Workspace) {
  return (["final", "base", "diff"] as const).map((view) => ws.queryRows(S, { view, columns: ALL_COLS, limit: 1000 }).rows);
}

describe("Workspace の性質", () => {
  it("ランダムな編集列（途中の取り消しを含む）を適用して全バッチを逆順に取り消すと最終ビューが base に戻る", () => {
    let totalBatches = 0;
    fc.assert(
      fc.property(fc.array(opWithUndoArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const ws = makeWorkspace();
        const baseline = ws.queryRows(S, { columns: ALL_COLS, limit: 1000 }).rows;
        const baseSummary = ws.summary(S);
        const batchIds: string[] = [];
        for (const op of ops) {
          const id = applyOp(ws, op);
          if (id !== null) batchIds.push(id);
          // 親の列は同じ親の全行で常に同じ値
          const sheet = ws.getSheet(S);
          const byParent = new Map<string, CellValue>();
          for (const key of sheet.rowKeys("base").concat(sheet.rowKeys("final"))) {
            const info = sheet.rowInfo(key);
            const p = sheet.rowValues(key)?.["P"] ?? null;
            if (!info) continue;
            if (byParent.has(info.parentKey)) expect(p).toBe(byParent.get(info.parentKey));
            else byParent.set(info.parentKey, p);
          }
        }
        totalBatches += batchIds.length;
        for (const id of [...batchIds].reverse()) {
          // 途中で取り消し済みになったバッチは飛ばす
          if (ws.listBatches(S).find((b) => b.batchId === id)?.undone) continue;
          const u = ws.undoBatch(id);
          expect(u.conflicts).toEqual([]);
        }
        expect(ws.queryRows(S, { columns: ALL_COLS, limit: 1000 }).rows).toEqual(baseline);
        expect(ws.getDiff(S).total).toBe(0);
        expect(ws.summary(S)).toEqual(baseSummary);
        expect(ws.listBatches(S).every((b) => b.undone)).toBe(true);
      }),
      { numRuns: 150 },
    );
    // 変更の無い操作ばかりで常に成功する試験になっていないこと
    expect(totalBatches).toBeGreaterThan(150);
  });

  it("ランダムな編集列の後に toJSON/fromJSON で往復しても同じビュー・差分・続きの取り消し結果になる", () => {
    fc.assert(
      fc.property(fc.array(opWithUndoArb, { minLength: 1, maxLength: 15 }), (ops) => {
        const ws = makeWorkspace();
        for (const op of ops) applyOp(ws, op);
        const restored = Workspace.fromJSON(JSON.parse(JSON.stringify(ws.toJSON())), { now: () => 0 });
        expect(restored.toJSON()).toEqual(ws.toJSON());
        expect(snapshot(restored)).toEqual(snapshot(ws));
        expect(restored.getDiff(S, { limit: 1000 })).toEqual(ws.getDiff(S, { limit: 1000 }));
        expect(restored.status()).toEqual(ws.status());
        const last = ws
          .listBatches(S)
          .filter((b) => !b.undone)
          .at(-1)?.batchId;
        if (last !== undefined) {
          expect(restored.undoBatch(last)).toEqual(ws.undoBatch(last));
          expect(snapshot(restored)).toEqual(snapshot(ws));
        }
      }),
      { numRuns: 80 },
    );
  });

  it("applied が 0 のときは batchId が null で revision も変わらない", () => {
    fc.assert(
      fc.property(opArb, (op) => {
        const ws = makeWorkspace();
        const before = ws.revision;
        const id = applyOp(ws, op);
        if (id === null) expect(ws.revision).toBe(before);
        else expect(ws.revision).toBe(before + 1);
      }),
    );
  });
});
