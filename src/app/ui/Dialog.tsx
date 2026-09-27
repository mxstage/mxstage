// 確認用の小さなモーダル。

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Corners } from "./Corners";

export interface DialogProps {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Esc で閉じる。閉じてはいけないダイアログ（カナリアの判断待ちなど）では渡さない */
  onClose?: () => void;
}

export function Dialog({ title, children, actions, onClose }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClose) onClose();
      }}
    >
      <div className="dialog blueprint" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <Corners />
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}
