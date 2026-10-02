// 設定の「更新」。今の版、自動の更新のオン／オフ、新しい版の確認と入れ方。
// 外へ問い合わせるのは、自動の更新がオンのとき（1 日 1 回）と「今すぐ確かめる」を押したときだけ。

import { Button, Toggle } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice } from "../ui/Notice";
import { settingsMessages as m } from "./messages";
import { createUpdatesApi, type UpdateStatus, type UpdatesApi } from "./updates";

/** 進んでいる間は状態を読み直す */
const POLL_MS = 3_000;

/** ダウンロードした場所をコピーする（エクスプローラーが前に出ないときに、アドレス欄へ貼れるように） */
function CopyPath({ path }: { path: string }) {
  const t = m().updates;
  const [copied, setCopied] = useState(false);
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip || typeof clip.writeText !== "function") return null;
  return (
    <Button
      kind="ghost"
      size="sm"
      onClick={() => {
        clip.writeText(path).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? t.copied : t.copyPath}
    </Button>
  );
}

export function UpdatesSection({ api: given }: { api?: UpdatesApi }) {
  const api = useMemo(() => given ?? createUpdatesApi(), [given]);
  const [status, setStatus] = useState<UpdateStatus | null | "loading">("loading");
  const [working, setWorking] = useState(false);
  const t = m().updates;

  const refresh = useCallback(async () => setStatus(await api.status()), [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const phase = status !== null && status !== "loading" ? status.phase : null;
  useEffect(() => {
    if (phase !== "applying" && phase !== "downloading" && phase !== "checking") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, refresh]);

  const act = async (fn: () => Promise<UpdateStatus | null>) => {
    setWorking(true);
    try {
      const next = await fn();
      setStatus(next ?? (await api.status()));
    } finally {
      setWorking(false);
    }
  };

  if (status === "loading") {
    return (
      <section className="card">
        <h2>{t.title}</h2>
        <p className="muted">{t.loading}</p>
      </section>
    );
  }
  if (status === null) {
    return (
      <section className="card">
        <h2>{t.title}</h2>
        <Notice kind="warning">{t.unavailable}</Notice>
      </section>
    );
  }

  const busy = working || status.phase === "applying" || status.phase === "downloading" || status.phase === "checking";
  return (
    <section className="card updates">
      <h2>{t.title}</h2>
      <p>{t.current(status.current, status.kind === "git" ? t.kindGit : t.kindBundle)}</p>
      <div className="field">
        <Toggle
          id="auto-update"
          labelText={t.autoLabel}
          labelA={t.off}
          labelB={t.on}
          toggled={status.autoUpdate}
          disabled={working}
          onToggle={(on: boolean) => void act(() => api.setAutoUpdate(on))}
        />
        <p className="muted small">{status.kind === "git" ? t.autoHelpGit : t.autoHelpBundle}</p>
        <p className="muted small">{t.privacy}</p>
      </div>

      <p className="muted small">{status.lastCheckAt === null ? t.neverChecked : t.lastChecked(new Date(status.lastCheckAt).toLocaleString())}</p>

      {status.phase === "applying" && <Notice kind="info">{t.applying}</Notice>}
      {status.phase === "downloading" && <Notice kind="info">{t.downloading}</Notice>}
      {status.phase === "restart_needed" && <Notice kind="success">{t.restartNeeded}</Notice>}
      {status.phase === "error" && status.error !== null && <Notice kind="error">{t.error(status.error)}</Notice>}

      {status.available && status.latest !== null && status.phase !== "applying" && status.phase !== "restart_needed" && (
        <Notice kind="info">
          {t.available(status.latest.version)}{" "}
          <a href={status.latest.pageUrl} target="_blank" rel="noreferrer">
            {t.whatsNew}
          </a>
        </Notice>
      )}
      {!status.available && status.latest !== null && status.phase !== "error" && <p className="muted small">{t.upToDate}</p>}

      {status.downloaded !== null && (
        <Notice kind="success">
          {t.downloaded}
          <br />
          <code className="mono">{status.downloaded}</code>{" "}
          <CopyPath path={status.downloaded} />
          <br />
          {t.installSteps}
          <br />
          {t.folderHint}
        </Notice>
      )}

      <div className="actions">
        {status.available && status.phase !== "applying" && status.phase !== "restart_needed" && (
          <Button kind="primary" disabled={busy} onClick={() => void act(() => api.install())}>
            {status.kind === "git" ? t.installGit : t.installBundle}
          </Button>
        )}
        <Button kind="secondary" disabled={busy} onClick={() => void act(() => api.check())}>
          {busy && status.phase === "checking" ? t.checking : t.checkNow}
        </Button>
      </div>
    </section>
  );
}
