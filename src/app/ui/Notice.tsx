// 画面の中に置く知らせ（Carbon の InlineNotification。閉じるボタンは出さない）。
// 中身には文字だけを置く（ボタンやリンクを入れると Carbon が拒む）。操作は知らせの外に置く。

import { InlineNotification } from "@carbon/react";
import type { ReactNode } from "react";

export type NoticeKind = "error" | "warning" | "success" | "info";

/** アイコンの読み上げ（Carbon の既定は英語の "error icon" など） */
const ICON_LABEL: Record<NoticeKind, string> = { error: "エラー", warning: "注意", success: "完了", info: "お知らせ" };

export interface NoticeProps {
  kind: NoticeKind;
  /** 太字の見出し（省略可） */
  title?: string;
  children?: ReactNode;
  /** 既定は status（読み上げは控えめ）。すぐに知らせる誤りは alert */
  role?: "status" | "alert";
  className?: string;
}

export function Notice({ kind, title, children, role = "status", className }: NoticeProps) {
  return (
    <InlineNotification
      kind={kind}
      lowContrast
      hideCloseButton
      role={role}
      title={title}
      statusIconDescription={ICON_LABEL[kind]}
      className={className ? `notice ${className}` : "notice"}
    >
      {children}
    </InlineNotification>
  );
}
