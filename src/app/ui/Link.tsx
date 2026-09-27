// 同じドキュメントの中で画面を切り替えるリンク（全画面遷移しない）。

import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { isPlainLeftClick, navigate } from "./routes";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
}

export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (rest.target && rest.target !== "_self") return;
    if (!isPlainLeftClick({ button: e.button, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, defaultPrevented: e.defaultPrevented })) return;
    e.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={handle} />;
}
