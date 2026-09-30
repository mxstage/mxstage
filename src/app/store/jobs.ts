// 長い処理（load_sheet など）の進捗。タブのメモリにだけ持ち、保存しない。

import type { JobState, JobStatus } from "../../shared/model";
import { StoreError } from "./errors";

export type JobKind = JobStatus["kind"];

interface JobEntry {
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
}

export interface JobRegistryOptions {
  /** 終わったジョブを何件まで残すか（古いものから消す） */
  maxFinished?: number;
  now?: () => number;
}

function randomSuffix(): string {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(4));
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function copyStatus(s: JobStatus): JobStatus {
  return { ...s, ...(s.result ? { result: { ...s.result } } : {}) };
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobEntry>();
  private seq = 0;
  private readonly maxFinished: number;
  private readonly now: () => number;

  constructor(opts: JobRegistryOptions = {}) {
    this.maxFinished = opts.maxFinished ?? 50;
    this.now = opts.now ?? Date.now;
  }

  startJob(kind: JobKind, init: { total?: number; message?: string } = {}): string {
    const jobId = `job${++this.seq}-${randomSuffix()}`;
    const status: JobStatus = { jobId, kind, state: "running", progress: 0 };
    if (init.total !== undefined) status.total = init.total;
    if (init.message !== undefined) status.message = init.message;
    this.jobs.set(jobId, { status, startedAt: this.now(), finishedAt: null });
    return jobId;
  }

  /** 進捗を更新する。終わったジョブへの更新は無視する（取り消し後に遅れて届く更新のため） */
  updateJob(jobId: string, patch: { progress?: number; total?: number; message?: string }): void {
    const e = this.entry(jobId);
    if (e.status.state !== "running") return;
    if (patch.progress !== undefined) e.status.progress = patch.progress;
    if (patch.total !== undefined) e.status.total = patch.total;
    if (patch.message !== undefined) e.status.message = patch.message;
  }

  finishJob(
    jobId: string,
    outcome: { state?: Exclude<JobState, "running">; result?: Record<string, unknown>; message?: string } = {},
  ): void {
    const e = this.entry(jobId);
    if (e.status.state !== "running") return;
    const state = outcome.state ?? "done";
    e.status.state = state;
    if (state === "done" && e.status.total !== undefined) e.status.progress = e.status.total;
    if (outcome.result !== undefined) e.status.result = outcome.result;
    if (outcome.message !== undefined) e.status.message = outcome.message;
    e.finishedAt = this.now();
    this.prune();
  }

  getJob(jobId: string): JobStatus {
    return copyStatus(this.entry(jobId).status);
  }

  listJobs(): JobStatus[] {
    return Array.from(this.jobs.values(), (e) => copyStatus(e.status));
  }

  private entry(jobId: string): JobEntry {
    const e = this.jobs.get(jobId);
    if (!e) throw new StoreError("job_not_found", `There is no job ${jobId} (jobs are lost when the tab is reloaded)`, { jobId });
    return e;
  }

  private prune(): void {
    const finished = Array.from(this.jobs.values())
      .filter((e) => e.finishedAt !== null)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (let i = 0; i < finished.length - this.maxFinished; i++) {
      const e = finished[i];
      if (e) this.jobs.delete(e.status.jobId);
    }
  }
}
