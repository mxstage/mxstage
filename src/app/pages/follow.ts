// AI の作業に表示を合わせる。AI がシートを作った・AI がシートを変えた・AI が反映を頼んだときに、そのシートのタブへ移る。
// 人が見ている表は人が選んだものなので、人がタブを選んだ直後（FOLLOW_PAUSE_MS の間）は動かさない。
// 人の直接の編集は、そのシートを見ているときにしか起きないので移らない。

import type { BatchAuthor } from "../../shared/model";
import type { ChangeEvent } from "../store";

/** 人がタブを選んでから、AI の作業に表示を合わせないでおく時間 */
export const FOLLOW_PAUSE_MS = 15_000;

/** その出来事で移る先のシート。移らなければ null */
export function followTarget(ev: ChangeEvent, authorOf: (batchId: string) => BatchAuthor | null): string | null {
  if (ev.sheet === null) return null;
  switch (ev.kind) {
    case "sheet_created":
      return ev.sheet;
    case "cells_changed":
    case "rows_added":
    case "rows_deleted":
      return ev.batchId !== undefined && authorOf(ev.batchId) === "llm" ? ev.sheet : null;
    default:
      return null;
  }
}

export interface AiFollowerDeps {
  workspace: {
    subscribe(listener: (ev: ChangeEvent) => void): () => void;
    readonly batches: readonly { batchId: string; author: BatchAuthor }[];
  };
  commits: {
    subscribe(listener: (sheet: string) => void): () => void;
    panel(sheet: string): { state: string; requestedAt?: number };
  };
  /** 表示をそのシートへ移す */
  show: (sheet: string) => void;
  now?: () => number;
  pauseMs?: number;
}

export class AiFollower {
  private pausedUntil = 0;
  /** シートごとに、表示を移した反映の依頼（同じ依頼で何度も移らない） */
  private readonly seenRequests = new Map<string, number | undefined>();
  private readonly now: () => number;
  private readonly pauseMs: number;

  constructor(private readonly deps: AiFollowerDeps) {
    this.now = deps.now ?? Date.now;
    this.pauseMs = deps.pauseMs ?? FOLLOW_PAUSE_MS;
  }

  /** 見張りを始める。戻り値で止める */
  start(): () => void {
    const { workspace, commits } = this.deps;
    const offWorkspace = workspace.subscribe((ev) => {
      const target = followTarget(ev, (id) => workspace.batches.find((b) => b.batchId === id)?.author ?? null);
      if (target !== null) this.go(target);
    });
    const offCommits = commits.subscribe((sheet) => {
      let panel;
      try {
        panel = commits.panel(sheet);
      } catch {
        return;
      }
      if (panel.state !== "requested") {
        this.seenRequests.delete(sheet);
        return;
      }
      if (this.seenRequests.has(sheet) && this.seenRequests.get(sheet) === panel.requestedAt) return;
      this.seenRequests.set(sheet, panel.requestedAt);
      this.go(sheet);
    });
    return () => {
      offWorkspace();
      offCommits();
    };
  }

  /** 人がタブを選んだ。しばらく AI の作業に表示を合わせない */
  userSelected(): void {
    this.pausedUntil = this.now() + this.pauseMs;
  }

  private go(sheet: string): void {
    if (this.now() < this.pausedUntil) return;
    this.deps.show(sheet);
  }
}
