// 作業タブ内のモジュール間の契約。
// UI（pages / grid / settings / boot）と、ツール実行（tools）・Maximo への反映（commit）をこの型でつなぐ。
// 実装: createToolRegistry → src/app/tools/registry.ts、createCommitController → src/app/commit/controller.ts、
//       ConnectionProvider → src/app/keyvault（UI 側）。

import type { BatchAuthor, CommitRowResult, CommitState } from "../../shared/model";
import type { ObjectStructureCatalog } from "../catalog/catalog";
import type { ImportStore } from "../imports";
import type { LicenseGate } from "../license/client";
import type { MaximoClient, MaximoVia } from "../maximo/client";
import type { WriteLogEntry } from "../maximo/commit";
import type { ToolHandler } from "../relay";
import type { JobRegistry, Workspace } from "../store";

/** Maximo の接続情報。API キーは含めない（キーは keyvault の Web Worker だけが持つ） */
export interface MaximoConnectionInfo {
  baseUrl: string;
  via: MaximoVia;
  /** パスワードマネージャーの username 欄に入れた接続名（例 MAXADMIN@mas-dev） */
  connectionName: string;
  /** whoami で確認した Maximo の利用者名 */
  userName: string | null;
  connectedAt: number;
}

export interface MaximoConnection {
  info: MaximoConnectionInfo;
  client: MaximoClient;
}

/** 現在の Maximo 接続。未接続・自動ロック中は null */
export interface ConnectionProvider {
  current(): MaximoConnection | null;
  subscribe(listener: () => void): () => void;
}

export interface CommitCounts {
  parents: number;
  changedCells: number;
  addedRows: number;
  deletedRows: number;
}

/** 反映パネルの状態（シートごと） */
export interface CommitPanelState {
  sheet: string;
  state: CommitState;
  /** 反映の依頼メモ（request_commit の note など） */
  note?: string;
  requestedBy?: BatchAuthor;
  requestedAt?: number;
  counts: CommitCounts;
  /** 反映前に分かっている問題（不変条件違反、未接続など）。空でない間は実行できない */
  blockers: string[];
  /** 削除件数が上限を超えるため、人の確認が要る（I3） */
  needsDeleteConfirm: boolean;
  /** null（空）への変更を含むため、人の確認が要る（I10） */
  needsNullConfirm: boolean;
  /** カナリア（最初の 1 件）の結果。人が続行を判断するまで残りを送らない */
  awaitingCanary: CommitRowResult | null;
  results: CommitRowResult[];
  startedAt?: number;
  finishedAt?: number;
  /** 直近の run が実行されなかった理由（未接続・確認不足・実行中など）。UI に表示する */
  message?: string;
  /** 反映先。シートを読み込んだオブジェクト構造と接続先（Maximo から読み込んだシートだけ） */
  target?: { os: string; baseUrl: string | null };
}

/**
 * LLM のツールから使える反映の口。実行（run）を含めない。
 * これにより、LLM のツール呼び出しからは Maximo へ書き込めないことを型で保証する。
 */
export interface CommitRequester {
  request(sheet: string, note: string, by: BatchAuthor): CommitPanelState;
  panel(sheet: string): CommitPanelState;
  /** 反映中のシート。編集系のツールと UI の直接編集はこの間 BUSY にする */
  isRunning(sheet: string): boolean;
}

/** UI だけが使う反映の口 */
export interface CommitController extends CommitRequester {
  /** 利用者が作業画面で [Maximo に反映] をクリックしたときだけ呼ぶ */
  run(sheet: string, opts: { allowNull?: boolean; deletesConfirmed?: boolean }): Promise<CommitPanelState>;
  /** カナリアの結果を見た利用者の判断 */
  continueCanary(sheet: string, proceed: boolean): void;
  /** 反映を打ち切る（利用者の操作）。送信済みの分は取り消さず、残りを skipped にして isRunning を解く */
  cancel(sheet: string): void;
  /** 依頼の強調表示を消す（反映はしない） */
  dismiss(sheet: string): void;
  subscribe(listener: (sheet: string) => void): () => void;
  /** 書き込みログ（キーと結果だけ。属性値を含めない） */
  writeLog(): readonly WriteLogEntry[];
  writeLogCsv(): string;
}

export interface CommitControllerDeps {
  workspace: Workspace;
  connection: ConnectionProvider;
  /** 作業画面に保存したオブジェクト構造。シートを読み込んだ後に定義が変わっていないかを反映の前に確かめる */
  catalog?: ObjectStructureCatalog;
  now?: () => number;
  /** 反映パネルの再計算の間引き時間（ミリ秒。既定 200） */
  refreshMs?: number;
  /**
   * ライセンスと環境（本番／テスト）。本番の接続先への反映にだけキーを求める（src/app/license）。
   * 作業画面では必ず渡す。省くと関門を通さない（反映の仕組みだけを試す試験用）
   */
  license?: LicenseGate;
}

export type CreateCommitController = (deps: CommitControllerDeps) => CommitController;

export interface ToolRegistryDeps {
  workspace: Workspace;
  jobs: JobRegistry;
  connection: ConnectionProvider;
  commits: CommitRequester;
  /** 読み込んだオブジェクト構造（作業画面の設定。作業をまたいで残る） */
  catalog: ObjectStructureCatalog;
  /** 作業画面に届いた Excel・CSV（describe_import・apply_mapping が読む） */
  imports?: ImportStore;
  appVersion: string;
  /** 作業画面の URL（例 http://127.0.0.1:8788/app） */
  appUrl: string;
  /**
   * ツールが呼ばれた（＝この作業画面は使われている）ことを知らせる。
   * API キーの自動ロックは「利用者がタブを触らないまま 30 分」で働くが、LLM と会話しながらの作業では
   * タブを触らない時間が長く続く。ツールの実行も使用中として数え、作業の途中でロックしない。
   */
  noteActivity?: () => void;
  now?: () => number;
}

export interface TabToolRegistry {
  /** hello で Hub に知らせるツール名（実装済みのものだけ） */
  tools: string[];
  handler: ToolHandler;
}

export type CreateToolRegistry = (deps: ToolRegistryDeps) => TabToolRegistry;
