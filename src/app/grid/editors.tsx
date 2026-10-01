// グリッドのセルの編集部品（Glide の provideEditor から開くオーバーレイの中身）。
// - 日付・日時: 書き慣れた形（2026/10/01 9:30 など）で打てる入力と、ブラウザのカレンダー（input type=date / datetime-local）。
//   カレンダーはブラウザが画面の上に出すので、Glide の「外を押したら閉じる」に掛からない。
// - 値の一覧: 候補を絞り込みながら選ぶ入力（Maximo の getlist、または引いて読み込んだマスタのシート）。一覧に無い値も入れられるが、注意を出す。
// キー操作: Enter で確定して下へ、Tab で確定して横へ、Esc で取り消し。変えずに閉じたら変更にしない
// （日付は表示の形と値の形が違うので、開いたときの表示と同じなら値を書き換えない）。
//
// 部品はモジュールの定数にして同じ型を使い回す（SheetGrid が作り直しても編集中の入力が消えないように）。
// 開いたセルの列や一覧は、SheetGrid が CellEditorContext で渡す（オーバーレイは portal でも React の文脈は届く）。

import { Calendar, WarningAltFilled } from "@carbon/icons-react";
import { GridCellKind, type GridCell, type ProvideEditorCallbackResult, type ProvideEditorComponent } from "@glideapps/glide-data-grid";
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import type { ColumnSchema } from "../../shared/model";
import type { ValueListItem, ValueListState } from "../maximo/valueList";
import { formatDateForDisplay, normalizeDateInput, parseDateInput } from "../store";
import { gridMessages } from "./messages";
import { filterItems, isInList } from "./valueLists";

export type CellListSource =
  | { kind: "master"; sheet: string; items: readonly ValueListItem[] }
  | { kind: "maximo"; initial: ValueListState | undefined; load: () => Promise<ValueListState> };

/** 開いているセルの編集の情報（SheetGrid の provideEditor が決める） */
export interface CellEditorTarget {
  col: ColumnSchema;
  /** 開いた時点の表示。これと同じ文字のまま閉じたら変更にしない */
  originalText: string;
  list?: CellListSource;
}

export const CellEditorContext = createContext<MutableRefObject<CellEditorTarget | null>>({ current: null });

type EditorProps = Parameters<ProvideEditorComponent<GridCell>>[0];
type Movement = readonly [-1 | 0 | 1, -1 | 0 | 1];

function textOf(cell: GridCell): string {
  return cell.kind === GridCellKind.Text ? cell.data : "";
}

/** 入力の変化をオーバーレイに伝える（外を押して閉じたときにも入るように）。開いたときと同じ文字に戻したら「変更なし」にする */
function report(props: EditorProps, original: string, text: string): void {
  const cell = props.value;
  if (cell.kind !== GridCellKind.Text) return;
  // Glide は onChange(undefined) を「変更なし」として扱う（型は GridCell だけを受けるので、ここだけ広げる）
  if (text === original) (props.onChange as (v: GridCell | undefined) => void)(undefined);
  else props.onChange({ ...cell, data: text });
}

function finish(props: EditorProps, original: string, text: string, movement: Movement): void {
  const cell = props.value;
  if (cell.kind !== GridCellKind.Text || text === original) props.onFinishedEditing(undefined, movement);
  else props.onFinishedEditing({ ...cell, data: text }, movement);
}

function useTarget(props: EditorProps, fallbackType: ColumnSchema["type"]): CellEditorTarget {
  const ref = useContext(CellEditorContext);
  // 開いたときの情報を最初の描画で固定する（開いている間に別のセルの情報に変わらないように）
  const [target] = useState<CellEditorTarget>(() => ref.current ?? { col: { name: "", type: fallbackType }, originalText: textOf(props.value) });
  return target;
}

function useFocusInput(props: EditorProps): MutableRefObject<HTMLInputElement | null> {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // 文字を打って開いたときは続けて打てるように末尾へ、Enter・ダブルクリックで開いたときは全体を選ぶ
    if (props.forceEditMode) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return inputRef;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** カレンダー（input type=date / datetime-local）に渡す値 */
function pickerValue(type: "date" | "datetime", text: string): string {
  const p = parseDateInput(text);
  if (p === null) return "";
  const date = `${String(p.y).padStart(4, "0")}-${pad2(p.mo)}-${pad2(p.d)}`;
  return type === "date" ? date : `${date}T${pad2(p.hh)}:${pad2(p.mi)}`;
}

/** 今日・今（ブラウザの時計）の入力の形 */
function nowText(type: "date" | "datetime", now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return type === "date" ? date : `${date} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 日付・日時
// ---------------------------------------------------------------------------

export function DateCellEditor(props: EditorProps) {
  const t = gridMessages().editor;
  const target = useTarget(props, "date");
  const type: "date" | "datetime" = target.col.type === "datetime" ? "datetime" : "date";
  const [text, setText] = useState(() => textOf(props.value));
  const [showError, setShowError] = useState(false);
  const [pickerShown, setPickerShown] = useState(false);
  const inputRef = useFocusInput(props);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();

  const blank = text.trim() === "";
  const normalized = blank ? null : normalizeDateInput(text, null);
  const valid = blank || normalized !== null;
  const preview = normalized === null ? null : formatDateForDisplay(type, normalized);

  const update = (next: string) => {
    setText(next);
    setShowError(false);
    report(props, target.originalText, next);
  };

  const submit = (movement: Movement) => {
    if (!valid) {
      setShowError(true);
      return;
    }
    finish(props, target.originalText, text, movement);
  };

  const openPicker = () => {
    const el = pickerRef.current;
    if (!el) return;
    el.value = pickerValue(type, text);
    const show = (el as HTMLInputElement & { showPicker?: () => void }).showPicker;
    try {
      if (typeof show === "function") {
        show.call(el);
        return;
      }
    } catch {
      // 表示中の要素でないと showPicker は失敗する。そのときは入力欄として見せる
    }
    setPickerShown(true);
    el.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit([0, 1]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      submit([e.shiftKey ? -1 : 1, 0]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onFinishedEditing(undefined, [0, 0]);
    } else if (e.key === "ArrowDown" && e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openPicker();
    }
  };

  let helper: { text: string; tone: "hint" | "error" | "preview" };
  if (showError && !valid) helper = { text: t.dateInvalid, tone: "error" };
  else if (preview !== null && preview !== text.trim()) helper = { text: t.datePreview(preview), tone: "preview" };
  else helper = { text: type === "date" ? t.dateHint : t.datetimeHint, tone: "hint" };

  return (
    <div className="mx-cell-editor mx-cell-editor--date">
      <div className="mx-cell-editor__row">
        <input
          ref={inputRef}
          className={`mx-cell-editor__input${showError && !valid ? " mx-cell-editor__input--invalid" : ""}`}
          type="text"
          value={text}
          placeholder={type === "date" ? t.datePlaceholder : t.datetimePlaceholder}
          aria-invalid={showError && !valid}
          aria-describedby={hintId}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="mx-cell-editor__icon" title={t.openCalendar} aria-label={t.openCalendar} onMouseDown={(e) => e.preventDefault()} onClick={openPicker}>
          <Calendar size={16} />
        </button>
        <button
          type="button"
          className="mx-cell-editor__text-button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            update(nowText(type));
            inputRef.current?.focus();
          }}
        >
          {type === "date" ? t.today : t.now}
        </button>
      </div>
      <input
        ref={pickerRef}
        className={pickerShown ? "mx-cell-editor__picker mx-cell-editor__picker--shown" : "mx-cell-editor__picker"}
        type={type === "date" ? "date" : "datetime-local"}
        aria-label={t.calendarLabel}
        tabIndex={pickerShown ? 0 : -1}
        aria-hidden={pickerShown ? undefined : true}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") return;
          update(type === "date" ? v : v.replace("T", " ").slice(0, 16));
          setPickerShown(false);
          inputRef.current?.focus();
        }}
        onKeyDown={(e) => {
          // カレンダーの入力欄で Enter・Esc を押したら、文字の入力欄に戻る（オーバーレイは閉じない）
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setPickerShown(false);
            inputRef.current?.focus();
          }
        }}
      />
      <div id={hintId} className={`mx-cell-editor__helper mx-cell-editor__helper--${helper.tone}`} role={helper.tone === "error" ? "alert" : undefined}>
        {helper.text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 値の一覧
// ---------------------------------------------------------------------------

/** 一覧に一度に出す件数（多い表は入力で絞り込んでもらう） */
const MAX_SHOWN = 300;

function initialListState(list: CellListSource | undefined): ValueListState {
  if (list === undefined) return { status: "none" };
  if (list.kind === "master") return list.items.length > 0 ? { status: "ready", items: list.items } : { status: "none" };
  return list.initial ?? { status: "loading" };
}

export function ValueListCellEditor(props: EditorProps) {
  const t = gridMessages().editor;
  const target = useTarget(props, "string");
  const [text, setText] = useState(() => textOf(props.value));
  // 文字を変えるまでは一覧の全部を出す（今の値の位置を見せる）。文字を変えたら絞り込む
  const [typed, setTyped] = useState(() => props.forceEditMode);
  const [state, setState] = useState<ValueListState>(() => initialListState(target.list));
  const [active, setActive] = useState(-1);
  const inputRef = useFocusInput(props);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();
  const helperId = useId();

  useEffect(() => {
    const list = target.list;
    if (list?.kind !== "maximo" || state.status !== "loading") return undefined;
    let alive = true;
    void list.load().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = state.status === "ready" ? state.items : [];
  const shown = useMemo(() => (typed ? filterItems(items, text) : items).slice(0, MAX_SHOWN), [items, typed, text]);

  // 一覧が来たら、今の値（大文字小文字は問わない）に印を付ける
  useEffect(() => {
    const lower = text.trim().toLowerCase();
    setActive(lower === "" ? -1 : shown.findIndex((i) => i.value.toLowerCase() === lower));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const update = (next: string) => {
    setText(next);
    setTyped(true);
    report(props, target.originalText, next);
  };

  const pick = (item: ValueListItem, movement: Movement) => {
    setText(item.value);
    finish(props, target.originalText, item.value, movement);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "ArrowDown") {
      stop();
      if (shown.length > 0) setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      stop();
      if (shown.length > 0) setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && !e.shiftKey) {
      stop();
      const item = active >= 0 ? shown[active] : undefined;
      if (item) pick(item, [0, 1]);
      else finish(props, target.originalText, text, [0, 1]);
    } else if (e.key === "Tab") {
      stop();
      const item = active >= 0 && typed ? shown[active] : undefined;
      if (item) pick(item, [e.shiftKey ? -1 : 1, 0]);
      else finish(props, target.originalText, text, [e.shiftKey ? -1 : 1, 0]);
    } else if (e.key === "Escape") {
      stop();
      props.onFinishedEditing(undefined, [0, 0]);
    }
  };

  const ready = state.status === "ready";
  // 一覧に無い値なら注意を出す（候補に印が付いていれば Enter でその候補を選ぶので出さない）
  const warn = ready && !isInList(items, text) && !(active >= 0 && shown[active] !== undefined);
  let helper: { text: string; tone: "hint" | "warning" } | null = null;
  if (state.status === "loading") helper = { text: t.listLoading, tone: "hint" };
  else if (warn) helper = { text: t.notInList, tone: "warning" };
  else if (ready && target.list?.kind === "master") helper = { text: t.listFromSheet(target.list.sheet, items.length), tone: "hint" };
  else if (ready) helper = { text: t.listFromMaximo(items.length), tone: "hint" };
  const activeItem = active >= 0 ? shown[active] : undefined;

  return (
    <div className="mx-cell-editor mx-cell-editor--list">
      <input
        ref={inputRef}
        className={`mx-cell-editor__input${warn ? " mx-cell-editor__input--warning" : ""}`}
        type="text"
        role="combobox"
        aria-label={t.listLabel(target.col.title ?? target.col.name)}
        aria-expanded={ready && shown.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeItem ? `${listId}-${active}` : undefined}
        aria-describedby={helper ? helperId : undefined}
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {helper && (
        <div id={helperId} className={`mx-cell-editor__helper mx-cell-editor__helper--${helper.tone}`}>
          {helper.tone === "warning" && <WarningAltFilled size={16} aria-hidden="true" />}
          <span>{helper.text}</span>
        </div>
      )}
      {ready && (
        <ul ref={listRef} id={listId} role="listbox" className="mx-cell-editor__list" aria-label={t.listLabel(target.col.title ?? target.col.name)}>
          {shown.length === 0 ? (
            <li className="mx-cell-editor__empty" role="presentation">
              {t.listNoMatch}
            </li>
          ) : (
            shown.map((item, i) => (
              <li
                key={item.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "mx-cell-editor__option mx-cell-editor__option--active" : "mx-cell-editor__option"}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(item, [0, 0])}
              >
                <span className="mx-cell-editor__value">{item.value}</span>
                {item.description !== undefined && <span className="mx-cell-editor__desc">{item.description}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** provideEditor が返す編集部品（同じオブジェクトを使い回す） */
export const DATE_EDITOR: ProvideEditorCallbackResult<GridCell> = { editor: DateCellEditor, disablePadding: true };
export const LIST_EDITOR: ProvideEditorCallbackResult<GridCell> = { editor: ValueListCellEditor, disablePadding: true };

/** 真偽値の列に打った文字（1/0・t/f・y/n、全角も可）を値にする。空白は切り替え（Glide に任せる）。それ以外は null */
export function booleanFromKey(key: string): boolean | null {
  const k = key.normalize("NFKC").toLowerCase();
  if (k === "1" || k === "t" || k === "y") return true;
  if (k === "0" || k === "f" || k === "n") return false;
  return null;
}

/** 貼り付けた文字を真偽値にする。読めなければ undefined（変えない） */
export function booleanFromText(text: string): boolean | null | undefined {
  const s = text.trim().normalize("NFKC").toLowerCase();
  if (s === "") return null;
  if (["true", "1", "y", "yes", "t", "on"].includes(s)) return true;
  if (["false", "0", "n", "no", "f", "off"].includes(s)) return false;
  return undefined;
}
