// 同じドキュメントの中で画面を切り替えるリンク（全画面遷移しない）。見た目は Carbon の Link。
// Carbon の Button・IconButton を画面の切り替えに使うときは href と onClick={spaClick(to)} を渡す。

import { Link as CarbonLink } from "@carbon/react";
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { isPlainLeftClick, navigate } from "./routes";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
}

/** 普通の左クリックなら全画面遷移をやめて、同じドキュメントの中で切り替える（新しいタブで開く操作はそのまま） */
export function spaClick(to: string, onClick?: (e: MouseEvent<HTMLAnchorElement>) => void) {
  // Carbon の Button は onClick を HTMLButtonElement の型で受けるので、要素の型は広く取る（href があれば <a> で描かれる）
  return (e: MouseEvent<HTMLElement>) => {
    onClick?.(e as MouseEvent<HTMLAnchorElement>);
    const target = e.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    if (!isPlainLeftClick({ button: e.button, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, defaultPrevented: e.defaultPrevented })) return;
    e.preventDefault();
    navigate(to);
  };
}

export function Link({ to, onClick, ...rest }: LinkProps) {
  return <CarbonLink {...rest} href={to} onClick={spaClick(to, onClick)} />;
}
