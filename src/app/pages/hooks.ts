// 作業画面の購読用フック。

import { useEffect, useState } from "react";

/**
 * 変更通知を requestAnimationFrame で間引いて、再描画用の番号を返す。
 * LLM の大量の変更でも 1 フレームに 1 回だけ描画する。
 */
export function useFrameVersion(subscribe: (onChange: () => void) => () => void): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setVersion((v) => v + 1);
      });
    };
    const unsubscribe = subscribe(schedule);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [subscribe]);
  return version;
}

/** 画面の幅（リサイズに追随する）。表を並べるか・パネルを出すかを決めるのに使う */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}
