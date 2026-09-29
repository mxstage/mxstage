// 画面下に一時的に出す通知。

import { ToastNotification } from "@carbon/react";
import { useCallback, useSyncExternalStore } from "react";

export type ToastTone = "info" | "error";

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

export interface ToastStoreOptions {
  max?: number;
  infoMs?: number;
  errorMs?: number;
}

export class ToastStore {
  private items: readonly ToastItem[] = [];
  private seq = 0;
  private readonly listeners = new Set<() => void>();
  private readonly max: number;
  private readonly infoMs: number;
  private readonly errorMs: number;

  constructor(opts: ToastStoreOptions = {}) {
    this.max = opts.max ?? 5;
    this.infoMs = opts.infoMs ?? 6_000;
    this.errorMs = opts.errorMs ?? 12_000;
  }

  show(text: string, tone: ToastTone = "info"): number {
    const id = ++this.seq;
    this.items = [...this.items, { id, text, tone }].slice(-this.max);
    this.emit();
    setTimeout(() => this.dismiss(id), tone === "error" ? this.errorMs : this.infoMs);
    return id;
  }

  dismiss(id: number): void {
    const next = this.items.filter((t) => t.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.emit();
  }

  getItems(): readonly ToastItem[] {
    return this.items;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of Array.from(this.listeners)) l();
  }
}

/** 画面の下に重ねる通知（Carbon の ToastNotification）。消す時間は ToastStore が決める */
export function Toasts({ store }: { store: ToastStore }) {
  const subscribe = useCallback((l: () => void) => store.subscribe(l), [store]);
  const getItems = useCallback(() => store.getItems(), [store]);
  const items = useSyncExternalStore(subscribe, getItems);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <ToastNotification
          key={t.id}
          className={`toast ${t.tone}`}
          kind={t.tone === "error" ? "error" : "info"}
          role={t.tone === "error" ? "alert" : "status"}
          title={t.text}
          aria-label="閉じる"
          statusIconDescription={t.tone === "error" ? "エラー" : "お知らせ"}
          onClose={() => {
            store.dismiss(t.id);
            return false;
          }}
        />
      ))}
    </div>
  );
}
