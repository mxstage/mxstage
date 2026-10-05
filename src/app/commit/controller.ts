// Maximo への反映を管理する CommitController。
// - シートごとに反映パネルの状態（依頼・件数・blockers・確認の要否・カナリア・行ごとの結果）を持つ。
// - run は利用者が作業画面で [Maximo に反映] をクリックしたときだけ UI から呼ぶ。
//   LLM のツールには run を持たない CommitRequester として渡すので、ツールからは書き込めない。
// - 反映を確かめた（verified）親だけ Maximo から読み直して base を置き換え、その親の overlay を消す。
//   conflict / error / unknown / skipped の親の変更は作業画面に残す。
// - 書き込みログはキーと結果だけ（属性値を含めない）。

import type { CommitRowResult } from "../../shared/model";
import { parseRowKey, type MaximoRecord, type SheetMeta } from "../../shared/sheet";
import { normalizeScope } from "../catalog/catalog";
import { structureDriftProblems } from "../catalog/drift";
import {
  COMMIT_LIMITS,
  CommitInvariantError,
  executeCommit,
  planCommit,
  writeLogEntry,
  type CommitChanges,
  type CommitPlan,
  type CommitRowOutcome,
  type InvariantCode,
  type InvariantHint,
  type WriteLogEntry,
} from "../maximo/commit";
import type { CommitController, CommitCounts, CommitPanelState, CreateCommitController, MaximoConnection } from "../runtime/contracts";
import { authorizeFailure, licenseBlocker } from "../license/gate";
import { getLocale } from "../../shared/i18n";
import { writeLogCsv } from "./csv";
import { commitMessages as m } from "./messages";
import { reloadParents } from "./reload";

/** 作業内容の変更を反映パネルに伝えるまでの間引き時間（CommitControllerDeps.refreshMs の既定） */
export const PANEL_REFRESH_MS = 200;
/** 書き込みログの保持件数（古いものから捨てる） */
export const MAX_WRITE_LOG_ENTRIES = 10_000;
/** 「行をすべて削除した親」を blockers に並べる上限（残りは件数だけ知らせる） */
export const MAX_UNWRITABLE_BLOCKERS = 5;
/** 1 件の blocker に並べる列名の上限 */
export const MAX_BLOCKER_COLUMNS = 10;

/** 名前を上限まで並べ、残りは件数だけにする（blockers が際限なく長くならないように） */
function joinNames(names: readonly string[], max: number): string {
  if (names.length <= max) return names.join(", ");
  return m().moreColumns(names.slice(0, max).join(", "), names.length - max);
}

// 文言は今の言語で返す（言語は途中で変わるので、モジュールの定数に取っておかない）
export const notConnectedBlocker = (): string => m().blocker.notConnected;
export const noChangesBlocker = (): string => m().blocker.noChanges;
export const notMaximoSheetBlocker = (): string => m().blocker.notMaximoSheet;

/** シートを読み込んだ接続先と、今の接続先が違う */
export function otherConnectionBlocker(sheetBaseUrl: string, currentBaseUrl: string): string {
  return m().blocker.otherConnection(sheetBaseUrl, currentBaseUrl);
}

/** シートを読み込んだ後に、オブジェクト構造の定義が取り直され、反映に使う列が変わった */
export function structureChangedBlocker(os: string, problems: readonly string[]): string {
  const listed = m().blocker.problemList(problems.slice(0, 3), Math.max(0, problems.length - 3));
  return m().blocker.structureChanged(os, listed);
}

// 反映しなかった理由・中止の文言（CommitPanelState.message に入れて UI に出す）
export const alreadyRunningMessage = (): string => m().run.alreadyRunning;
export const blockedMessagePrefix = (): string => m().run.blockedPrefix;
export const needsNullConfirmMessage = (): string => m().run.needsNullConfirm;
export const needsDeleteConfirmMessage = (): string => m().run.needsDeleteConfirm;
export const planFailedMessagePrefix = (): string => m().run.planFailedPrefix;
export const cancelledMessage = (): string => m().run.cancelled;
/** 中止で送らなかった行の結果に入れる文言 */
export const cancelledRowNote = (): string => m().run.cancelledRow;

const ZERO_COUNTS: CommitCounts = { parents: 0, changedCells: 0, addedRows: 0, deletedRows: 0 };

function skipNote(reason: "sheet_replaced" | "changed_since" | "invalid_rows"): string {
  const note = m().note;
  return reason === "sheet_replaced" ? note.sheetReplaced : reason === "changed_since" ? note.changedSince : note.invalidRows;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : m().unknownError;
}

interface Evaluation {
  counts: CommitCounts;
  blockers: string[];
  needsDeleteConfirm: boolean;
  needsNullConfirm: boolean;
}

export interface PlanAttempt {
  plans: CommitPlan[];
  /** 確認が無いと I3（削除件数の上限）に引っかかる */
  needsDeleteConfirm: boolean;
  /** 確認が無いと I10（null への変更）に引っかかる */
  needsNullConfirm: boolean;
  /** I3 / I10 以外で計画を作れなかった理由（利用者向けの文言。末尾の括弧に内部コードを残す） */
  error: string | null;
}

/** 不変条件ごとに、利用者が次にできることを書く */
function adviceFor(code: InvariantCode, hint: InvariantHint | undefined): string {
  const a = m().advice;
  if (code === "INPUT") return hint !== undefined ? a[hint] : a.input;
  switch (code) {
    case "I2":
      return a.I2;
    case "I3":
      return a.I3(COMMIT_LIMITS.maxDeletesPerParent, COMMIT_LIMITS.maxDeletesTotal);
    case "I4":
      return a.I4;
    case "I5":
      return a.I5;
    case "I6":
      return a.I6;
    case "I7":
      return a.I7;
    case "I8":
      return a.I8(COMMIT_LIMITS.maxParentsPerPlan);
    case "I10":
      return a.I10;
    default:
      return a.other;
  }
}

/** 書き込みエンジンの内部コードだけの文言を、利用者が次にできることの分かる文にする */
export function describePlanError(e: unknown): string {
  if (!(e instanceof CommitInvariantError)) return m().advice.planFailed(e instanceof Error && e.message !== "" ? e.message : m().unknownError);
  const prefix = `[${e.code}] `;
  const detail = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
  return m().advice.withDetail(adviceFor(e.code, e.hint), e.code, detail);
}

/**
 * 計画を作る。I3 / I10 は「人の確認が要る」ことが分かればよいので、確認済みとして作り直して他の問題も見る。
 * I3 / I10 以外の不変条件違反は error（blockers になる）。
 */
export function attemptPlan(
  meta: SheetMeta,
  records: readonly MaximoRecord[],
  changes: CommitChanges,
  confirmed: { allowNull?: boolean; deletesConfirmed?: boolean } = {},
): PlanAttempt {
  let allowNull = confirmed.allowNull === true;
  let deletesConfirmed = confirmed.deletesConfirmed === true;
  let needsNullConfirm = false;
  let needsDeleteConfirm = false;
  for (let i = 0; i < 3; i++) {
    try {
      return { plans: planCommit(meta, [...records], changes, { allowNull, deletesConfirmed }), needsDeleteConfirm, needsNullConfirm, error: null };
    } catch (e) {
      if (e instanceof CommitInvariantError && e.code === "I10" && !allowNull) {
        needsNullConfirm = true;
        allowNull = true;
        continue;
      }
      if (e instanceof CommitInvariantError && e.code === "I3" && !deletesConfirmed) {
        needsDeleteConfirm = true;
        deletesConfirmed = true;
        continue;
      }
      return { plans: [], needsDeleteConfirm, needsNullConfirm, error: describePlanError(e) };
    }
  }
  return { plans: [], needsDeleteConfirm, needsNullConfirm, error: m().advice.other };
}

function distinctParents(changes: CommitChanges): number {
  const keys = new Set<string>();
  for (const c of changes.cells) keys.add(parseRowKey(c.rowKey).parentKey);
  for (const r of changes.addedRows) keys.add(r.parentKey);
  for (const k of changes.deletedRows) keys.add(parseRowKey(k).parentKey);
  return keys.size;
}

function rowResult(o: CommitRowOutcome): CommitRowResult {
  const out: CommitRowResult = { rowKey: o.rowKey, status: o.status };
  if (o.httpStatus !== undefined) out.httpStatus = o.httpStatus;
  if (o.reasonCode !== undefined) out.reasonCode = o.reasonCode;
  if (o.message !== undefined) out.message = o.message;
  return out;
}

function clonePanel(p: CommitPanelState): CommitPanelState {
  return {
    ...p,
    counts: { ...p.counts },
    blockers: [...p.blockers],
    awaitingCanary: p.awaitingCanary === null ? null : { ...p.awaitingCanary },
    results: p.results.map((r) => ({ ...r })),
  };
}

interface Entry {
  panel: CommitPanelState;
  canaryResolve: ((proceed: boolean) => void) | null;
  /** 利用者が中止したか（run のたびに false に戻す） */
  cancelled: boolean;
  /** 中止した時点の results の件数。これ以降に skipped になった行の文言を中止に書き換える */
  cancelledAt: number;
  /** 本番への反映の直前に、橋渡しでライセンスを確かめている間（二重の実行と編集を止める） */
  starting: boolean;
}

export const createCommitController: CreateCommitController = (deps) => {
  const { workspace, connection } = deps;
  const now = deps.now ?? Date.now;
  // パネル再計算の間引き時間（負の値・数でない値は既定に戻す）
  const refreshMs = typeof deps.refreshMs === "number" && Number.isFinite(deps.refreshMs) && deps.refreshMs >= 0 ? Math.trunc(deps.refreshMs) : PANEL_REFRESH_MS;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(sheet: string) => void>();
  const log: WriteLogEntry[] = [];
  const evalCache = new Map<string, { key: string; ev: Evaluation }>();

  function idlePanel(sheet: string): CommitPanelState {
    return { sheet, state: "idle", counts: { ...ZERO_COUNTS }, blockers: [], needsDeleteConfirm: false, needsNullConfirm: false, awaitingCanary: null, results: [] };
  }

  function ensure(sheet: string): Entry {
    let e = entries.get(sheet);
    if (e === undefined) {
      e = { panel: idlePanel(sheet), canaryResolve: null, cancelled: false, cancelledAt: 0, starting: false };
      entries.set(sheet, e);
    }
    return e;
  }

  /** 件数と blockers を計算する（同じ revision・同じ接続先・同じ構造の定義なら計算し直さない） */
  function evaluate(sheet: string): Evaluation {
    const conn = connection.current();
    const connected = conn !== null;
    if (!workspace.hasSheet(sheet)) {
      return { counts: { ...ZERO_COUNTS }, blockers: [m().blocker.sheetMissing(sheet)], needsDeleteConfirm: false, needsNullConfirm: false };
    }
    const s = workspace.getSheet(sheet);
    const source = s.meta.source;
    // シートを読み込んだ構造の、作業画面に保存している今の定義（取り直すと loadedAt が変わる）
    const structure = source.kind === "maximo" && source.baseUrl !== undefined && deps.catalog ? deps.catalog.get(source.baseUrl, source.os) : null;
    // blockers は今の言語の文なので、言語が変わったら計算し直す
    const key = `${getLocale()}:${s.id}:${workspace.revision}:${conn === null ? "-" : normalizeScope(conn.info.baseUrl)}:${structure?.loadedAt ?? "-"}:${deps.license?.snapshot().version ?? "-"}`;
    const hit = evalCache.get(sheet);
    if (hit !== undefined && hit.key === key) return hit.ev;
    const summary = s.summary();
    const counts: CommitCounts = { parents: 0, changedCells: summary.changedCells, addedRows: summary.addedRows, deletedRows: summary.deletedRows };
    const blockers: string[] = [];
    let needsDeleteConfirm = false;
    let needsNullConfirm = false;
    if (source.kind !== "maximo") {
      blockers.push(notMaximoSheetBlocker());
    } else {
      const changes = workspace.changes(sheet);
      counts.parents = distinctParents(changes);
      const attempt = attemptPlan(s.meta, s.records, changes);
      needsDeleteConfirm = attempt.needsDeleteConfirm;
      needsNullConfirm = attempt.needsNullConfirm;
      if (attempt.error !== null) blockers.push(attempt.error);
      else if (attempt.plans.length === 0 && changes.unwritableParentEdits.length === 0) blockers.push(noChangesBlocker());
      else counts.parents = attempt.plans.length;
      // 新しく作るレコード（追加した親の行）。計画を作れなかったときは追加した親の行で数える
      counts.newRecords = attempt.error === null ? attempt.plans.filter((p) => p.create !== undefined).length : changes.addedRows.filter((r) => r.childName === null).length;
      // 行がすべて削除された親に残った親の列の変更は、どの行にも付け替えられないので書き込めない（黙って捨てない）。
      // 親の数だけ並べると blockers が際限なく膨らみ、request_commit / get_status の結果が上限を超えるので件数を区切る
      const unwritable = changes.unwritableParentEdits;
      for (const u of unwritable.slice(0, MAX_UNWRITABLE_BLOCKERS)) {
        blockers.push(m().blocker.parentRowsDeleted(u.parentKey, joinNames(u.columns, MAX_BLOCKER_COLUMNS)));
      }
      if (unwritable.length > MAX_UNWRITABLE_BLOCKERS) {
        blockers.push(m().blocker.moreParentRowsDeleted(unwritable.length - MAX_UNWRITABLE_BLOCKERS));
      }
      // 反映は、シートを読み込んだ接続先の、読み込んだオブジェクト構造に対してだけ行う
      if (conn !== null && source.baseUrl !== undefined && normalizeScope(conn.info.baseUrl) !== normalizeScope(source.baseUrl)) {
        blockers.push(otherConnectionBlocker(source.baseUrl, conn.info.baseUrl));
      }
      if (structure !== null && source.structureLoadedAt !== undefined && structure.loadedAt > source.structureLoadedAt) {
        const problems = structureDriftProblems(s.meta, structure.info, changes);
        if (problems.length > 0) blockers.push(structureChangedBlocker(source.os, problems));
      }
    }
    if (!connected) blockers.push(notConnectedBlocker());
    // 本番の接続先への反映にだけライセンスを求める（テスト環境・本番での読み込みと編集は無償）
    if (conn !== null && deps.license !== undefined && source.kind === "maximo") {
      const why = licenseBlocker(deps.license, conn.info.baseUrl);
      if (why !== null) blockers.push(why);
    }
    const ev: Evaluation = { counts, blockers, needsDeleteConfirm, needsNullConfirm };
    evalCache.set(sheet, { key, ev });
    return ev;
  }

  function panel(sheet: string): CommitPanelState {
    const e = entries.get(sheet);
    const p = e === undefined ? idlePanel(sheet) : e.panel;
    if (p.state !== "running") {
      const ev = evaluate(sheet);
      p.counts = { ...ev.counts };
      p.blockers = [...ev.blockers];
      p.needsDeleteConfirm = ev.needsDeleteConfirm;
      p.needsNullConfirm = ev.needsNullConfirm;
    }
    // 反映先（シートを読み込んだオブジェクト構造と接続先）
    const source = workspace.hasSheet(sheet) ? workspace.getSheet(sheet).meta.source : null;
    if (source?.kind === "maximo") p.target = { os: source.os, baseUrl: source.baseUrl ?? null };
    else delete p.target;
    return clonePanel(p);
  }

  function emit(sheet: string): void {
    for (const l of Array.from(listeners)) {
      try {
        l(sheet);
      } catch {
        // 表示側の失敗で反映を止めない
      }
    }
  }

  // 作業内容の変更は間引いて伝える（1 セルずつの変更で計画を作り直さない）
  const pending = new Set<string>();
  let refreshAll = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefresh(sheet: string | null): void {
    if (sheet === null) refreshAll = true;
    else pending.add(sheet);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const names = new Set(pending);
      pending.clear();
      if (refreshAll) {
        refreshAll = false;
        for (const n of workspace.sheets.keys()) names.add(n);
        for (const n of entries.keys()) names.add(n);
      }
      for (const n of names) {
        if (entries.get(n)?.panel.state !== "running") {
          try {
            evaluate(n);
          } catch {
            // 計算できなければ panel() で作り直す
          }
        }
        emit(n);
      }
    }, refreshMs);
  }

  workspace.subscribe((ev) => {
    if (ev.kind === "editing_changed") return;
    scheduleRefresh(ev.sheet);
  });
  connection.subscribe(() => scheduleRefresh(null));
  // オブジェクト構造の定義を取り直したら、それを使うシートの反映の可否を計算し直す
  deps.catalog?.subscribe(() => scheduleRefresh(null));
  // ライセンスキー・環境の申告が変わったら、反映の可否を計算し直す
  deps.license?.subscribe(() => scheduleRefresh(null));

  function appendLog(entry: WriteLogEntry): void {
    log.push(entry);
    if (log.length > MAX_WRITE_LOG_ENTRIES) log.splice(0, log.length - MAX_WRITE_LOG_ENTRIES);
  }

  /** verified の親を読み直して base を置き換える。置き換えられなかった親は理由を返す */
  async function applyVerified(
    sheet: string,
    sheetId: number,
    since: number,
    conn: MaximoConnection,
    parentKeys: string[],
    created: ReadonlyMap<string, string>,
  ): Promise<Map<string, string>> {
    const notes = new Map<string, string>();
    if (!workspace.hasSheet(sheet) || workspace.getSheet(sheet).id !== sheetId) {
      for (const pk of parentKeys) notes.set(pk, skipNote("sheet_replaced"));
      return notes;
    }
    let outcome;
    try {
      outcome = await reloadParents(conn.client, workspace.getSheet(sheet), parentKeys, created);
    } catch (e) {
      const why = errorText(e);
      for (const pk of parentKeys) notes.set(pk, m().note.reloadFailed(why));
      return notes;
    }
    for (const [pk, why] of outcome.failures) notes.set(pk, m().note.kept(why));
    if (outcome.replacements.length > 0) {
      try {
        const res = workspace.replaceParents(sheet, outcome.replacements, { sheetId, unchangedSince: since });
        for (const s of res.skipped) notes.set(s.parentKey, skipNote(s.reason));
      } catch (e) {
        const why = errorText(e);
        for (const r of outcome.replacements) notes.set(r.parentKey, m().note.updateFailed(why));
      }
    }
    return notes;
  }

  /** run を実行しなかったときに、理由を message に入れてパネルを返す */
  function notRun(sheet: string, message: string): CommitPanelState {
    const e = ensure(sheet);
    e.panel.message = message;
    emit(sheet);
    return panel(sheet);
  }

  const controller: CommitController = {
    request(sheet, note, by) {
      const e = ensure(sheet);
      if (e.panel.state !== "running") {
        e.panel = { ...idlePanel(sheet), state: "requested", note, requestedBy: by, requestedAt: now() };
        emit(sheet);
      }
      return panel(sheet);
    },

    panel,

    isRunning(sheet) {
      const e = entries.get(sheet);
      return e !== undefined && (e.panel.state === "running" || e.starting);
    },

    async run(sheet, opts) {
      const entry = ensure(sheet);
      // 反映中の呼び出しには理由を返すが、実行中のパネルの message（中止など）は書き換えない
      if (entry.panel.state === "running" || entry.starting) return { ...panel(sheet), message: alreadyRunningMessage() };
      const conn = connection.current();
      const ev = evaluate(sheet);
      if (conn === null || ev.blockers.length > 0) {
        const why = ev.blockers.length > 0 ? ev.blockers : [notConnectedBlocker()];
        return notRun(sheet, `${blockedMessagePrefix()}${why.join(" / ")}`);
      }
      const allowNull = opts.allowNull === true;
      const deletesConfirmed = opts.deletesConfirmed === true;
      // 人の確認が要る変更は、確認済みで呼ばれたときだけ実行する
      if ((ev.needsNullConfirm && !allowNull) || (ev.needsDeleteConfirm && !deletesConfirmed)) {
        const why: string[] = [];
        if (ev.needsNullConfirm && !allowNull) why.push(needsNullConfirmMessage());
        if (ev.needsDeleteConfirm && !deletesConfirmed) why.push(needsDeleteConfirmMessage());
        return notRun(sheet, why.join(" "));
      }
      const s = workspace.getSheet(sheet);
      const meta = s.meta;
      const attempt = attemptPlan(meta, s.records, workspace.changes(sheet), { allowNull, deletesConfirmed });
      if (attempt.error !== null) return notRun(sheet, `${planFailedMessagePrefix()}${attempt.error}`);
      if (attempt.plans.length === 0) return notRun(sheet, `${blockedMessagePrefix()}${noChangesBlocker()}`);
      // 本番の接続先なら、送る直前に橋渡しでライセンスをもう一度確かめる（手元の一覧が古いこともある）。
      // 確かめている間は反映中と同じ扱いにして、二重の実行と編集を止める
      const license = deps.license;
      if (license !== undefined && license.environmentOf(conn.info.baseUrl) !== "test") {
        entry.starting = true;
        emit(sheet);
        let outcome: Awaited<ReturnType<typeof license.authorize>>;
        try {
          outcome = await license.authorize(conn.info.baseUrl);
        } finally {
          entry.starting = false;
        }
        if (!outcome.ok) return notRun(sheet, `${blockedMessagePrefix()}${authorizeFailure(outcome, conn.info.baseUrl)}`);
        // 確かめている間に接続先が変わっていたら送らない
        const still = connection.current();
        if (still === null || normalizeScope(still.info.baseUrl) !== normalizeScope(conn.info.baseUrl)) {
          return notRun(sheet, `${blockedMessagePrefix()}${still === null ? notConnectedBlocker() : otherConnectionBlocker(conn.info.baseUrl, still.info.baseUrl)}`);
        }
      }
      const plans = attempt.plans;
      const sheetId = s.id;
      const startRevision = workspace.revision;

      const p = entry.panel;
      p.state = "running";
      p.counts = { ...ev.counts };
      p.blockers = [];
      p.needsDeleteConfirm = ev.needsDeleteConfirm;
      p.needsNullConfirm = ev.needsNullConfirm;
      p.awaitingCanary = null;
      p.results = [];
      p.startedAt = now();
      delete p.finishedAt;
      // 実行したので、前回「実行しなかった理由」は消す
      delete p.message;
      entry.cancelled = false;
      entry.cancelledAt = 0;
      emit(sheet);

      // 送信前の検査で止まった（1 件も書き込めなかった）ことを結果の state に出すため
      let aborted = false;
      // 新しく作ったレコード（親キー → Maximo が返した href）。反映のあと画面を読み直すのに使う
      const created = new Map<string, string>();
      try {
        await executeCommit(conn.client, plans, {
          waitForCanaryContinue: (canary) =>
            new Promise<boolean>((resolve) => {
              entry.canaryResolve = resolve;
              p.awaitingCanary = rowResult(canary);
              emit(sheet);
            }),
          onRow: (r, plan) => {
            if (r.createdHref !== undefined) created.set(r.rowKey, r.createdHref);
            p.results.push(rowResult(r));
            appendLog(writeLogEntry(plan, r, now()));
            emit(sheet);
            // 中止されたら、この行（送信済み）を記録してから残りを送らせない。
            // executeCommit には打ち切りの口が無く、onRow が例外を投げると残りを skipped にして返す仕様を使う
            if (entry.cancelled) throw new Error("cancelled");
          },
          meta,
          childIdAttrs: meta.childIdAttrs,
          // 送信先はシートを読み込んだオブジェクト構造のレコードに限る（I7）
          ...(meta.source.kind === "maximo" ? { os: meta.source.os } : {}),
          allowNull,
          maxDeletesConfirmed: deletesConfirmed,
        });
      } catch (e) {
        // 送信前の検査で止めた（1 件も送っていない）。書き込めていないので done（成功）にはしない
        aborted = true;
        const reason = m().run.precheckStopped(errorText(e));
        const done = new Set(p.results.map((r) => r.rowKey));
        for (const plan of plans) if (!done.has(plan.parentKey)) p.results.push({ rowKey: plan.parentKey, status: "skipped", message: reason });
      } finally {
        entry.canaryResolve = null;
        p.awaitingCanary = null;
      }

      const verified = p.results.filter((r) => r.status === "verified").map((r) => r.rowKey);
      if (verified.length > 0) {
        const notes = await applyVerified(sheet, sheetId, startRevision, conn, verified, created);
        for (const r of p.results) {
          const note = notes.get(r.rowKey);
          if (note !== undefined && r.status === "verified") r.message = r.message === undefined ? note : m().note.append(r.message, note);
        }
      }
      if (entry.cancelled) {
        // 中止した後に skipped になった行は、書き込みエンジンの内部の理由（中止は onRow の例外で伝えている）ではなく中止と書く。
        // 中止より前に止まっていた行（前の行の失敗・カナリアの中断）は cancelledAt より前なので、その理由のまま残る
        p.results.forEach((r, i) => {
          if (i >= entry.cancelledAt && r.status === "skipped") r.message = cancelledRowNote();
        });
        p.message = cancelledMessage();
      }
      const failedRows = p.results.some((r) => r.status === "error" || r.status === "unknown" || r.status === "conflict");
      p.state = failedRows || aborted ? "failed" : "done";
      p.finishedAt = now();
      evalCache.delete(sheet);
      emit(sheet);
      return panel(sheet);
    },

    continueCanary(sheet, proceed) {
      const e = entries.get(sheet);
      const resolve = e?.canaryResolve;
      if (e === undefined || resolve === null || resolve === undefined) return;
      e.canaryResolve = null;
      e.panel.awaitingCanary = null;
      resolve(proceed);
      emit(sheet);
    },

    cancel(sheet) {
      const e = entries.get(sheet);
      // 反映中でなければ何もしない（送信済みの分は取り消せない）
      if (e === undefined || e.panel.state !== "running") return;
      if (!e.cancelled) {
        e.cancelled = true;
        e.cancelledAt = e.panel.results.length;
      }
      e.panel.message = cancelledMessage();
      const resolve = e.canaryResolve;
      if (resolve !== null && resolve !== undefined) {
        // カナリアの確認待ちなら「続行しない」として残りを送らせない
        e.canaryResolve = null;
        e.panel.awaitingCanary = null;
        resolve(false);
      }
      emit(sheet);
    },

    dismiss(sheet) {
      const e = entries.get(sheet);
      if (e === undefined || e.panel.state === "running") return;
      e.panel.state = "idle";
      delete e.panel.note;
      delete e.panel.requestedBy;
      delete e.panel.requestedAt;
      // 依頼を閉じたら、前回の「反映しませんでした」の理由も消す（古い理由が残り続けないように）
      delete e.panel.message;
      emit(sheet);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    writeLog() {
      return log.map((e) => ({ ...e, ops: { ...e.ops, attrs: [...e.ops.attrs] } }));
    },

    writeLogCsv() {
      return writeLogCsv(log);
    },
  };

  return controller;
};
