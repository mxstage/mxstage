// 「読み替えを足す」: 見つからない行から、その場で辞書に呼び名を足し、同じ条件で突き合わせ直す。
// 足した項目は辞書の保存前の変更になる（保存すると共有される）。

import { Button, Select, SelectItem, TextInput } from "@carbon/react";
import { useEffect, useId, useRef, useState } from "react";
import { dictionaryMessages } from "../dictionaries/messages";

export interface AddAliasPopoverProps {
  /** 画面での位置（押したセルの下） */
  x: number;
  y: number;
  /** 文の中の書き方の初めの値（行の文） */
  initialFind: string;
  /** 正しい名前の候補（相手の名前） */
  names: readonly string[];
  /** 今の接続先の呼び名の辞書（無ければ新しい辞書を作る） */
  dictionaries: readonly string[];
  defaultDictionary: string | null;
  onSubmit: (input: { find: string; to: string; dictionary: string | null }) => Promise<void>;
  onClose: () => void;
}

const NEW = "\u0001new";

export function AddAliasPopover({ x, y, initialFind, names, dictionaries, defaultDictionary, onSubmit, onClose }: AddAliasPopoverProps) {
  const t = dictionaryMessages().addAlias;
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [find, setFind] = useState(initialFind);
  const [to, setTo] = useState("");
  const [dict, setDict] = useState(defaultDictionary ?? dictionaries[0] ?? NEW);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const width = 380;
  const left = Math.max(8, Math.min(x, (typeof window === "undefined" ? 1200 : window.innerWidth) - width - 8));
  const top = Math.min(y, (typeof window === "undefined" ? 800 : window.innerHeight) - 360);
  const ready = find.trim() !== "" && to.trim() !== "" && !busy;

  return (
    <div className="add-alias" ref={ref} style={{ left, top, width }} role="dialog" aria-label={t.title}>
      <h3>{t.title}</h3>
      <TextInput id={`${id}-find`} labelText={t.findLabel} helperText={t.findHelp} value={find} onChange={(e) => setFind(e.target.value)} size="md" />
      {/* 候補はブラウザの入力候補（datalist）。打つと絞られ、候補に無い言葉もそのまま入れられる */}
      <TextInput id={`${id}-to`} labelText={t.toLabel} helperText={t.toHelp} value={to} onChange={(e) => setTo(e.target.value)} size="md" list={`${id}-names`} autoComplete="off" />
      <datalist id={`${id}-names`}>
        {names.slice(0, 2000).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <Select id={`${id}-dict`} labelText={t.dictLabel} value={dict} onChange={(e) => setDict(e.target.value)} size="md">
        {dictionaries.map((d) => (
          <SelectItem key={d} value={d} text={d} />
        ))}
        <SelectItem value={NEW} text={t.newDictionary(t.defaultName)} />
      </Select>
      <div className="add-alias-actions">
        <Button kind="secondary" size="md" onClick={onClose}>
          {t.cancel}
        </Button>
        <Button
          kind="primary"
          size="md"
          disabled={!ready}
          onClick={() => {
            setBusy(true);
            void onSubmit({ find: find.trim(), to: to.trim(), dictionary: dict === NEW ? null : dict }).finally(() => setBusy(false));
          }}
        >
          {t.submit}
        </Button>
      </div>
    </div>
  );
}
