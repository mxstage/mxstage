// 画面のルート: /app と /settings を同じドキュメントの中で切り替える。
// 画面はこのパソコンの橋渡し（127.0.0.1）が配る。ログインも作業キーも無い。

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "../store";
import { getLocale, subscribeLocale } from "../../shared/i18n";
import { confirmWorkMoved, fetchWorkFromOtherWindow, parkWork, unparkWork, type SessionStorageLike } from "../boot/handoff";
import type { Runtime } from "../boot/runtime";
import type { AppServices } from "../boot/types";
import { AppPage } from "../pages/AppPage";
import { SettingsPage } from "../settings/SettingsPage";
import { StructuresPage } from "../structures/StructuresPage";
import { NAVIGATE_EVENT, navigate, resolveRoute } from "./routes";
import { uiMessages } from "./messages";
import { Toasts } from "./toast";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/** このタブの sessionStorage（使えなければ null） */
function tabStorage(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function Root({ services }: { services: AppServices }) {
  const [path, setPath] = useState(() => window.location.pathname);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  // 言語を切り替えたら画面を作り直す（作業データは runtime にあるので消えない）
  const [locale, setLocale] = useState(getLocale);
  useEffect(() => subscribeLocale(setLocale), []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);

  const route = resolveRoute(path);
  const redirectTo = route.kind === "redirect" ? route.to : null;
  useEffect(() => {
    if (redirectTo !== null) navigate(redirectTo, { replace: true });
  }, [redirectTo]);

  // 利用者の操作で API キーの自動ロックの時計を戻す
  useEffect(() => {
    const onActivity = () => services.vault.noteActivity();
    for (const t of ACTIVITY_EVENTS) window.addEventListener(t, onActivity, { capture: true, passive: true });
    return () => {
      for (const t of ACTIVITY_EVENTS) window.removeEventListener(t, onActivity, { capture: true });
    };
  }, [services]);

  /**
   * 作業（runtime）を作り直す。initial があれば、別の窓から移してきた作業で始める。
   * この窓の作業が別の窓へ移り終わったら（onReleased）、空の作業で作り直す
   */
  const startRuntime = useCallback(
    (initial?: Workspace): Runtime => {
      runtimeRef.current?.dispose();
      const rt: Runtime = services.createRuntime({
        ...(initial ? { workspace: initial } : {}),
        onReleased: () => {
          if (runtimeRef.current !== rt) return;
          startRuntime();
          services.toasts.show(uiMessages().handoff.movedAway);
        },
      });
      runtimeRef.current = rt;
      rt.start();
      setRuntime(rt);
      return rt;
    },
    [services],
  );

  // 作業画面を初めて開いたときに中継を始める。設定画面だけのタブは primary を奪わないよう接続しない。
  // 再読み込みの前に作業を預けていれば（版違いの再読み込みなど）、受け取ってその作業で始める
  const startingRef = useRef(false);
  useEffect(() => {
    if (route.kind !== "app" || runtimeRef.current !== null || startingRef.current) return;
    startingRef.current = true;
    void unparkWork(tabStorage()).then((kept) => {
      startingRef.current = false;
      if (runtimeRef.current !== null) return;
      startRuntime(kept.kind === "restored" ? kept.workspace : undefined);
      if (kept.kind === "restored") services.toasts.show(uiMessages().handoff.restored);
      else if (kept.kind === "lost") services.toasts.show(uiMessages().handoff.lost, "error");
    });
  }, [route.kind, startRuntime, services]);

  /** 再読み込みの前に作業を預ける */
  const keepWorkForReload = useCallback(async () => {
    const rt = runtimeRef.current;
    return rt ? parkWork(rt.workspace, tabStorage()) : false;
  }, []);

  useEffect(
    () => () => {
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    },
    [],
  );

  const endWork = useCallback(() => {
    startRuntime();
    services.toasts.show(uiMessages().workEnded);
  }, [services, startRuntime]);

  /** 別の窓にある作業をこの窓へ移す（作業画面の「この窓に移す」） */
  const moveWorkHere = useCallback(async () => {
    const current = runtimeRef.current;
    if (!current) return;
    const t = uiMessages().handoff;
    const got = await fetchWorkFromOtherWindow(current.tabId);
    if (!got.ok) {
      services.toasts.show(t.failed[got.reason], "error");
      return;
    }
    const rt = startRuntime(got.workspace);
    await confirmWorkMoved(got.token, rt.tabId);
    services.toasts.show(t.movedHere);
  }, [services, startRuntime]);

  if (route.kind === "settings") {
    return (
      <>
        <SettingsPage
          key={locale}
          vault={services.vault}
          license={services.license}
          connections={services.connections}
          autoConnect={services.autoConnect}
          imports={services.imports ?? null}
        />
        <Toasts store={services.toasts} />
      </>
    );
  }
  if (route.kind === "structures") {
    // 作業画面を開いていれば中継はそのまま続く（runtime は作り直さない）。この画面だけのタブは中継につながない
    return (
      <>
        <StructuresPage key={locale} catalog={services.catalog} vault={services.vault} toasts={services.toasts} workspace={runtime?.workspace ?? null} />
        <Toasts store={services.toasts} />
      </>
    );
  }
  if (route.kind === "app" && runtime) {
    return <AppPage key={locale} runtime={runtime} vault={services.vault} toasts={services.toasts} catalog={services.catalog} license={services.license} onEndWork={endWork} onMoveWorkHere={moveWorkHere} keepWorkForReload={keepWorkForReload} />;
  }
  return null;
}
