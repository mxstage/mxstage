// 上部バーの表示文言（中継・Maximo）。純関数。

import type { RelayStatus } from "../relay";
import type { VaultView } from "../keyvault/client";

export type BadgeTone = "ok" | "warn" | "error" | "muted";

export interface RelayBadge {
  text: string;
  tone: BadgeTone;
  title: string;
  /** 版違い: 再読み込みボタンを出す */
  showReload: boolean;
}

/** remainingMs: 再接続までの残り（毎秒数え直す）。null なら status.nextRetryMs を使う */
export function relayBadge(status: RelayStatus | null, remainingMs: number | null = null): RelayBadge {
  const connecting: RelayBadge = { text: "中継: 接続中", tone: "muted", title: "中継サーバに接続しています。", showReload: false };
  if (status === null) return { text: "中継: 未接続", tone: "muted", title: "", showReload: false };
  switch (status.state) {
    case "connecting":
      return connecting;
    case "open":
      if (status.role === "primary") {
        return { text: "中継: primary", tone: "ok", title: "LLM のツールはこのタブで実行されます。", showReload: false };
      }
      if (status.role === "mirror") {
        return {
          text: "中継: ミラー",
          tone: "warn",
          title: "LLM のツールは別のタブで実行されます。このタブを操作すると、このタブが primary になります。",
          showReload: false,
        };
      }
      return connecting;
    case "reconnecting": {
      const ms = remainingMs ?? status.nextRetryMs;
      const sec = ms === null ? null : Math.max(0, Math.ceil(ms / 1000));
      return {
        text: sec === null ? "中継: 再接続中" : `中継: 再接続中（${sec} 秒後）`,
        tone: "warn",
        title: "中継サーバとの接続が切れました。自動で再接続します（作業データはこのタブに残っています）。",
        showReload: false,
      };
    }
    case "protocol_mismatch":
      return {
        text: "中継: 版違い",
        tone: "error",
        title: "作業画面の版が古い可能性があります。再読み込みしてください（このタブの作業データと API キーは消えます）。",
        showReload: true,
      };
    case "closed":
      return { text: "中継: 停止", tone: "muted", title: "中継サーバに接続していません。", showReload: false };
  }
}

/**
 * 再接続がこの回数続いたら、作業画面を開き直す案内を出す
 * （WebSocket ではハンドシェイクの 401 がブラウザから見えないため、鍵切れも回線断も同じ見え方になる）。
 * 待ち時間は 0.5 秒から倍々（BACKOFF_BASE_MS）なので、5 回目はおよそ 15 秒後。
 * これより短くすると一瞬の回線の揺れでも出てしまい、本当に鍵が切れたときの案内が読み飛ばされる。
 */
export const REOPEN_HINT_AFTER = 5;

export function shouldSuggestReopen(status: RelayStatus): boolean {
  return status.state === "reconnecting" && status.attempt >= REOPEN_HINT_AFTER;
}

export interface ReopenHint {
  text: string;
  title: string;
}

/**
 * 再接続が続いたときの案内。このパソコンの橋渡しが止まっている可能性がある。
 * 【開き直しを勧めない】中継は自動で再接続し続けるので、橋渡しが同じポートで動き出せばこのタブのままつながる。
 *   作業データと API キーはこのタブのメモリにしか無いので、開き直すと消える。
 */
export function reopenHint(): ReopenHint {
  return {
    text: "つながらないときは橋渡しの起動を確かめてください",
    title:
      "このパソコンの橋渡し（mxstudio。Claude Code が起動します）が止まっていると、中継につながりません。橋渡しが動き出せば、このタブは自動でつなぎ直します。作業データと API キーはこのタブのメモリにしか無いので、タブを閉じたり再読み込みしたりしないでください。",
  };
}

export interface MaximoBadge {
  text: string;
  tone: BadgeTone;
  /** 設定画面へのリンクの文言。不要なら null */
  settingsLink: string | null;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 上部バーの接続の ○。色は中継と Maximo のうち悪いほう。文言は title（と読み上げ）に入れ、画面には出さない */
export interface ConnectionIndicator {
  tone: BadgeTone;
  /** 読み上げ用（中継と Maximo の状態） */
  label: string;
  /** マウスを置いたときに出す全文（作業名・中継・Maximo） */
  title: string;
}

const TONE_RANK: Record<BadgeTone, number> = { ok: 0, muted: 1, warn: 2, error: 3 };

export function connectionIndicator(relay: RelayBadge, maximo: MaximoBadge, workspaceName: string): ConnectionIndicator {
  const tone = TONE_RANK[maximo.tone] > TONE_RANK[relay.tone] ? maximo.tone : relay.tone;
  const relayText = relay.title ? `${relay.text}（${relay.title}）` : relay.text;
  return {
    tone,
    label: `${relay.text}／${maximo.text}`,
    title: `作業: ${workspaceName}\n${relayText}\n${maximo.text}`,
  };
}

export function maximoBadge(view: VaultView): MaximoBadge {
  switch (view.kind) {
    case "disconnected":
      return { text: "Maximo: 未接続", tone: "muted", settingsLink: "設定で接続" };
    case "locked":
      return { text: "Maximo: ロック中", tone: "warn", settingsLink: "設定で再接続" };
    case "connected": {
      const user = view.info.userName ? ` / ${view.info.userName}` : "";
      return { text: `Maximo: ${view.info.connectionName}（${hostOf(view.info.baseUrl)}${user}）`, tone: "ok", settingsLink: null };
    }
  }
}
