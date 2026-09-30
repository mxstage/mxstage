// 画面のルート: /app と /settings を同じドキュメントの中で切り替える。
// 画面はこのパソコンの橋渡し（127.0.0.1）が配る。ログインも作業キーも無い。

import { useCallback, useEffect, useRef, useState } from "react";
import type { Runtime } from "../boot/runtime";
import type { AppServices } from "../boot/types";
import { AppPage } from "../pages/AppPage";
import { SettingsPage } from "../settings/SettingsPage";
import { StructuresPage } from "../structures/StructuresPage";
import { NAVIGATE_EVENT, navigate, resolveRoute } from "./routes";
import { Toasts } from "./toast";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

export function Root({ services }: { services: AppServices }) {
  const [path, setPath] = useState(() => window.location.pathname);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);

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

  // 作業画面を初めて開いたときに中継を始める。設定画面だけのタブは primary を奪わないよう接続しない
  useEffect(() => {
    if (route.kind !== "app" || runtimeRef.current !== null) return;
    const rt = services.createRuntime();
    runtimeRef.current = rt;
    rt.start();
    setRuntime(rt);
  }, [route.kind, services]);

  useEffect(
    () => () => {
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    },
    [],
  );

  const endWork = useCallback(() => {
    runtimeRef.current?.dispose();
    const rt = services.createRuntime();
    runtimeRef.current = rt;
    rt.start();
    setRuntime(rt);
    services.toasts.show("作業を終了しました。新しい作業を始めます。");
  }, [services]);

  if (route.kind === "settings") {
    return (
      <>
        <SettingsPage vault={services.vault} license={services.license} />
        <Toasts store={services.toasts} />
      </>
    );
  }
  if (route.kind === "structures") {
    // 作業画面を開いていれば中継はそのまま続く（runtime は作り直さない）。この画面だけのタブは中継につながない
    return (
      <>
        <StructuresPage catalog={services.catalog} vault={services.vault} toasts={services.toasts} workspace={runtime?.workspace ?? null} />
        <Toasts store={services.toasts} />
      </>
    );
  }
  if (route.kind === "app" && runtime) {
    return <AppPage runtime={runtime} vault={services.vault} toasts={services.toasts} catalog={services.catalog} license={services.license} onEndWork={endWork} />;
  }
  return null;
}
