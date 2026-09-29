// 確認用の小さなモーダル（Carbon の ComposedModal）。
// 呼ぶ側は開いている間だけ描く（{open && <Dialog …/>}）。Carbon のモーダルは閉じても中身を DOM に残すため。

import { ComposedModal, FeatureFlags, ModalBody, ModalFooter, ModalHeader } from "@carbon/react";
import type { ReactNode } from "react";

export interface DialogProps {
  title: string;
  children: ReactNode;
  /** 右下のボタン（Carbon の Button。secondary → primary の順に並べる） */
  actions: ReactNode;
  /** Esc と × で閉じる。閉じてはいけないダイアログ（カナリアの判断待ちなど）では渡さない（× も出さない） */
  onClose?: () => void;
}

export function Dialog({ title, children, actions, onClose }: DialogProps) {
  return (
    // フォーカスを閉じ込める見えないボタン（英語の "Focus sentinel"）を置かない
    <FeatureFlags enableFocusWrapWithoutSentinels>
      <ComposedModal
        open
        size="sm"
        aria-label={title}
        className={onClose ? "mx-dialog" : "mx-dialog mx-dialog--locked"}
        // 外側を押しても閉じない（確認を読み飛ばさないため）
        preventCloseOnClickOutside
        // 最初のフォーカスは「やめる」側に置く（Enter で反映してしまわないように）
        selectorPrimaryFocus=".cds--modal-footer .cds--btn--secondary"
        onClose={() => {
          onClose?.();
          // 閉じるかどうかは呼ぶ側が決める（描かなくなれば消える）。Carbon に自分で隠させない
          return false;
        }}
      >
        <ModalHeader title={title} iconDescription="閉じる" />
        <ModalBody>{children}</ModalBody>
        <ModalFooter>{actions}</ModalFooter>
      </ComposedModal>
    </FeatureFlags>
  );
}
