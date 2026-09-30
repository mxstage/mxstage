// 作業タブ（メインスレッド）と、API キーを持つ専用 Web Worker の間のメッセージ。
// キーは unlock でメインスレッドから Worker へ 1 回だけ渡り、Worker からメインスレッドへは戻らない。

import type { MaximoVia } from "../maximo/client";

/** MaximoClient に API キーの代わりに渡す文字列。Worker が送信直前に本物のキーへ置き換える（秘密ではない） */
export const VAULT_SENTINEL = "mxstage-vault-sentinel";

/** 利用者の操作がこの時間無ければ、Worker がキーを消す */
export const VAULT_IDLE_MS = 30 * 60 * 1000;

export interface VaultFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface VaultFetchResponse {
  status: number;
  statusText: string;
  /** content-type など必要最小限のヘッダだけ */
  headers: Record<string, string>;
  bodyText: string;
}

export type VaultErrorCode = "locked" | "forbidden_destination" | "bad_request" | "network" | "aborted";

export type VaultLockReason = "idle" | "manual";

export type MainToVault =
  | { type: "unlock"; id: number; apiKey: string; via: MaximoVia; baseUrl: string }
  | { type: "lock"; id: number }
  | { type: "fetch"; id: number; request: VaultFetchRequest }
  /** 実行中の fetch（id）を中止する */
  | { type: "abort"; id: number }
  /** 利用者の操作があった（自動ロックの時計を戻す） */
  | { type: "activity" };

export type VaultToMain =
  | { type: "reply"; id: number; ok: true; response?: VaultFetchResponse }
  | { type: "reply"; id: number; ok: false; code: VaultErrorCode; message: string }
  | { type: "locked"; reason: VaultLockReason };
