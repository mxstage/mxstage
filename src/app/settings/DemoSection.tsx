// 設定の「デモ」。Maximo が無くても、この PC の中の架空の Maximo（ごみ焼却施設 3 か所）で MX Stage を試す。
// - 「データを落としてつなぐ」を押したときだけ、橋渡しが置き場所（mxstage-demo.pages.dev）から架空のデータを落とす（src/bridge/demo.ts）。
// - 落とし終えたら、予約の接続先（demo-ja・demo-en）に保存した接続先と同じ道でつなぐ（AutoConnector.connect）。
// - サンプルの Excel は、作業画面にドロップしたのと同じ置き場（ImportStore）に入れるか、ダウンロードする。

import { Button, ProgressBar, RadioButton, RadioButtonGroup } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DEMO_CONNECTION_IDS, demoLangOfBaseUrl, isDemoLang, type DemoExcelEntry, type DemoLang } from "../../shared/demo";
import { getLocale } from "../../shared/i18n";
import type { AutoConnector } from "../connections/auto";
import type { SavedConnectionsClient } from "../connections/client";
import { createDemoApi, type DemoApi, type DemoState } from "../demo/client";
import { demoMessages as m } from "../demo/messages";
import type { ImportStore } from "../imports";
import { spaClick } from "../ui/Link";
import { Notice } from "../ui/Notice";
import { APP_PATH } from "../ui/routes";
import type { SettingsVault } from "./SettingsPage";

/** 落としている間は状態を読み直す */
const POLL_MS = 700;

export interface DemoSectionProps {
  api?: DemoApi;
  vault: SettingsVault;
  connections: SavedConnectionsClient | null;
  autoConnect: AutoConnector | null;
  /** サンプルの Excel を入れる置き場（作業画面と同じ）。省くと「作業画面に取り込む」を出さない */
  imports?: ImportStore | null;
  confirm?: (question: string) => boolean;
  /** 既定は crypto.subtle */
  digest?: (bytes: Uint8Array) => Promise<string>;
  newImportId?: () => string;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function subtleSha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

function randomImportId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return `demo-${hex(b.buffer)}`;
}

function CopyButton({ text }: { text: string }) {
  const t = m();
  const [copied, setCopied] = useState(false);
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip || typeof clip.writeText !== "function") return null;
  return (
    <Button
      kind="ghost"
      size="sm"
      onClick={() => {
        clip.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? t.copied : t.copy}
    </Button>
  );
}

export function DemoSection(props: DemoSectionProps) {
  const { vault, connections, autoConnect } = props;
  const api = useMemo(() => props.api ?? createDemoApi(), [props.api]);
  const confirmFn = props.confirm ?? ((q: string) => window.confirm(q));
  const t = m();

  const view = useSyncExternalStore(
    useCallback((l: () => void) => vault.subscribe(l), [vault]),
    useCallback(() => vault.getView(), [vault]),
  );
  const connectedLang = view.kind === "connected" ? demoLangOfBaseUrl(view.info.baseUrl) : null;

  const [state, setState] = useState<DemoState | "loading">("loading");
  const [lang, setLang] = useState<DemoLang>(() => connectedLang ?? (getLocale() === "ja" ? "ja" : "en"));
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);
  /** 落とし終えたらつなぐ（「データを落としてつなぐ」を押したとき） */
  const [connectAfterDownload, setConnectAfterDownload] = useState<DemoLang | null>(null);

  const refresh = useCallback(async () => {
    const next = await api.status();
    setState(next);
    return next;
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const status = state !== "loading" && state.kind === "ready" ? state.status : null;
  const langStatus = status?.languages[lang] ?? null;
  const downloading = status !== null && Object.values(status.languages).some((l) => l.state === "downloading");
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [downloading, refresh]);

  const connectTo = useCallback(
    async (target: DemoLang) => {
      if (!connections || !autoConnect) return;
      setWorking(true);
      setMessage({ kind: "info", text: t.connecting });
      try {
        await connections.refresh();
        const entry = connections.find(DEMO_CONNECTION_IDS[target]);
        if (!entry) throw new Error(t.errors.not_downloaded ?? "not downloaded");
        await autoConnect.connect(entry);
        setMessage({ kind: "success", text: t.connected });
      } catch (e) {
        setMessage({ kind: "error", text: t.connectFailed(e instanceof Error && e.message ? e.message : String(e)) });
      } finally {
        setWorking(false);
        void refresh();
      }
    },
    [autoConnect, connections, refresh, t],
  );

  // 落とし終えたら、そのままつなぐ
  useEffect(() => {
    if (connectAfterDownload === null || status === null) return;
    const s = status.languages[connectAfterDownload];
    if (s.state === "ready") {
      setConnectAfterDownload(null);
      void connectTo(connectAfterDownload);
    } else if (s.state === "failed") {
      setConnectAfterDownload(null);
    }
  }, [connectAfterDownload, connectTo, status]);

  /** 落とし始める（終わったら上の効果でつなぐ）。始められなければつなぐ予定も消す */
  const startDownload = async (target: DemoLang) => {
    setConnectAfterDownload(target);
    setWorking(true);
    setMessage(null);
    try {
      const next = await api.download(target);
      setState(next);
      const s = next.kind === "ready" ? next.status.languages[target] : null;
      if (s === null || (s.state !== "downloading" && s.state !== "ready")) setConnectAfterDownload(null);
      if (next.kind === "ready" && next.error !== null) setMessage({ kind: "error", text: t.failed(t.errors[next.error] ?? next.error) });
      else if (next.kind !== "ready") setMessage({ kind: "error", text: t.unavailable });
    } finally {
      setWorking(false);
    }
  };

  const act = async (fn: () => Promise<DemoState>, done?: string) => {
    setWorking(true);
    setMessage(null);
    try {
      const next = await fn();
      setState(next);
      if (next.kind === "ready" && next.error !== null) setMessage({ kind: "error", text: t.failed(t.errors[next.error] ?? next.error) });
      else if (done) setMessage({ kind: "success", text: done });
    } finally {
      setWorking(false);
    }
  };

  const loadIntoApp = async (file: DemoExcelEntry) => {
    if (!props.imports) return;
    setWorking(true);
    try {
      const bytes = await api.excel(lang, file.id);
      const sha256 = bytes === null ? null : await (props.digest ?? subtleSha256)(bytes);
      if (bytes === null || sha256 !== file.sha256) {
        setMessage({ kind: "error", text: t.loadFailed });
        return;
      }
      const importId = (props.newImportId ?? randomImportId)();
      props.imports.add(
        { importId, fileName: file.fileName, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes, sha256 },
        { dropped: true },
      );
      setMessage({ kind: "success", text: t.loadedIntoApp(file.fileName) });
    } finally {
      setWorking(false);
    }
  };

  if (state === "loading") {
    return (
      <section className="card demo">
        <h2>{t.title}</h2>
        <p className="muted">{t.loading}</p>
      </section>
    );
  }
  if (state.kind !== "ready" || status === null || langStatus === null) {
    return (
      <section className="card demo">
        <h2>{t.title}</h2>
        <p>{t.intro}</p>
        <Notice kind="warning">{state.kind === "disabled" ? t.disabled : t.unavailable}</Notice>
      </section>
    );
  }

  const busy = working || downloading || connectAfterDownload !== null;
  const ready = langStatus.state === "ready";
  const isConnectedHere = connectedLang === lang;
  const excel = status.excel[lang] ?? [];
  const sizeMb = ((langStatus.totalBytes ?? 0) / 1_000_000).toFixed(1);

  return (
    <section className="card demo">
      <h2>{t.title}</h2>
      <p>{t.intro}</p>

      <div className="field">
        <RadioButtonGroup
          legendText={t.languageLabel}
          name="demo-language"
          orientation="horizontal"
          valueSelected={lang}
          onChange={(v) => {
            if (isDemoLang(v)) {
              setLang(v);
              setMessage(null);
            }
          }}
        >
          <RadioButton id="demo-lang-ja" value="ja" labelText={t.languages.ja} disabled={busy} />
          <RadioButton id="demo-lang-en" value="en" labelText={t.languages.en} disabled={busy} />
        </RadioButtonGroup>
      </div>

      {langStatus.state === "downloading" && (
        <ProgressBar
          label={t.downloading(langStatus.receivedBytes, langStatus.totalBytes)}
          value={langStatus.totalBytes ? Math.min(100, (langStatus.receivedBytes / langStatus.totalBytes) * 100) : undefined}
          max={100}
          size="small"
        />
      )}
      {langStatus.state === "failed" && <Notice kind="error">{t.failed(t.errors[langStatus.error ?? ""] ?? langStatus.error ?? "")}</Notice>}
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}

      {!ready && (
        <>
          <p className="muted small">{t.downloadNote(status.dataHost)}</p>
          <p className="muted small">{t.memoryNote}</p>
          <div className="actions">
            <Button
              kind="primary"
              disabled={busy || !connections || !autoConnect}
              onClick={() => void startDownload(lang)}
            >
              {langStatus.state === "failed" ? t.retry : t.download}
            </Button>
          </div>
        </>
      )}

      {ready && (
        <>
          <p className="muted small">
            {t.ready(sizeMb)}
            {status.loaded?.language === lang ? ` ${t.loadedInMemory}.` : ""}
          </p>
          <p className="muted small">{t.memoryNote}</p>
          <div className="actions">
            {isConnectedHere ? (
              <Button kind="primary" href={APP_PATH} onClick={spaClick(APP_PATH)}>
                {t.openApp}
              </Button>
            ) : (
              <Button kind="primary" disabled={busy || !connections || !autoConnect} onClick={() => void connectTo(lang)}>
                {t.connect}
              </Button>
            )}
            <Button
              kind="secondary"
              disabled={busy || status.loaded?.language !== lang}
              onClick={() => {
                if (confirmFn(t.resetConfirm)) void act(() => api.reset(), t.resetDone);
              }}
            >
              {t.reset}
            </Button>
            <Button
              kind="secondary"
              disabled={busy || status.loaded?.language !== lang}
              onClick={() => {
                if (isConnectedHere) autoConnect?.disconnect();
                void act(() => api.close(), t.closeDone);
              }}
            >
              {t.close}
            </Button>
            <Button
              kind="danger--ghost"
              disabled={busy}
              onClick={() => {
                if (!confirmFn(t.removeConfirm)) return;
                if (isConnectedHere) autoConnect?.disconnect();
                void act(async () => {
                  const next = await api.remove(lang);
                  await connections?.refresh();
                  return next;
                });
              }}
            >
              {t.remove}
            </Button>
          </div>

          {excel.length > 0 && (
            <div className="demo-excel">
              <h3>{t.excelTitle}</h3>
              <p className="muted small">{t.excelIntro}</p>
              <ul className="demo-files">
                {excel.map((f) => (
                  <li key={f.id} data-excel={f.id}>
                    <div>
                      <strong>{f.title}</strong>
                      <p className="muted small">{t.excel[f.id]}</p>
                    </div>
                    <div className="actions">
                      {props.imports && (
                        <Button kind="tertiary" size="sm" disabled={busy} onClick={() => void loadIntoApp(f)}>
                          {t.loadIntoApp}
                        </Button>
                      )}
                      <Button kind="ghost" size="sm" href={api.excelUrl(lang, f.id)}>
                        {t.downloadFile}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="demo-prompts">
            <h3>{t.promptsTitle}</h3>
            <ul>
              {Object.entries(t.prompts).map(([key, text]) => (
                <li key={key}>
                  <span>{text}</span> <CopyButton text={text} />
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
