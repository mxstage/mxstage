// 上部バーの「辞書」: 今の接続先の辞書の一覧（共有フォルダかこの PC だけか）、開く、新しい辞書を作る。
// アイコンだけにせず、文字の付いたボタンにする。保存していない変更があれば件数を出す。

import { Book } from "@carbon/icons-react";
import { Button, TextInput } from "@carbon/react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { dictionaryMessages } from "../dictionaries/messages";
import type { DictionaryService } from "../dictionaries/service";
import { Dialog } from "../ui/Dialog";
import { Link } from "../ui/Link";
import { settingsPath } from "../ui/routes";

export interface DictionaryMenuProps {
  service: DictionaryService;
  /** 開いている辞書のシートの、保存していない変更の数（シートの名前 → 数） */
  unsaved: ReadonlyMap<string, number>;
  /** 接続名（一覧の見出しに使う） */
  connectionName: string | null;
  onOpened: (sheet: string) => void;
  onMessage: (text: string, tone: "info" | "error") => void;
}

export function DictionaryMenu({ service, unsaved, connectionName, onOpened, onMessage }: DictionaryMenuProps) {
  const t = dictionaryMessages();
  const snap = useSyncExternalStore(
    (l) => service.subscribe(l),
    () => service.snapshot(),
  );
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const totalUnsaved = Array.from(unsaved.values()).reduce((a, b) => a + b, 0);

  useEffect(() => {
    if (!open) return undefined;
    void service.refresh();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, service]);

  const openOne = async (id: string) => {
    setOpen(false);
    const res = await service.openDictionary(id);
    if (res.ok) onOpened(res.value.sheet);
    else onMessage(t.toasts.openFailed(res.message), "error");
  };

  const listing = snap.listing;
  const folder = listing?.folder ?? null;
  const unsavedOf = (name: string) => {
    for (const [sheet, n] of unsaved) if (service.openOf(sheet)?.name === name) return n;
    return 0;
  };

  return (
    <div className="dictionary-menu" ref={ref}>
      <button type="button" className={`tb-button${open ? " open" : ""}`} aria-expanded={open} title={t.menu.buttonTitle} onClick={() => setOpen((o) => !o)}>
        <Book size={16} aria-hidden="true" />
        <span>{t.menu.button}</span>
        {totalUnsaved > 0 && <span className="count">{totalUnsaved}</span>}
      </button>
      {open && (
        <div className="dictionary-list" role="menu" aria-label={t.menu.button}>
          <div className="dictionary-list-head">
            <strong>{connectionName ? t.menu.title(connectionName) : t.menu.button}</strong>
            {folder !== null && <span className="muted small">{folder.path === null ? t.menu.local : t.menu.shared(t.sync[folder.sync ?? "local"])}</span>}
          </div>
          {snap.scope === null ? (
            <p className="dictionary-list-note">{t.menu.notConnected}</p>
          ) : snap.status === "loading" ? (
            <p className="dictionary-list-note">{t.menu.loading}</p>
          ) : snap.status === "failed" ? (
            <p className="dictionary-list-note error-text">{t.menu.failed}</p>
          ) : (
            <>
              {folder !== null && folder.path !== null && !folder.reachable && <p className="dictionary-list-note error-text">{t.menu.unreachable}</p>}
              {listing !== null && listing.dictionaries.length === 0 && folder?.reachable !== false && <p className="dictionary-list-note">{t.menu.empty}</p>}
              <ul className="plain">
                {(listing?.dictionaries ?? []).map((d) => {
                  const n = unsavedOf(d.name);
                  return (
                    <li key={d.id}>
                      <button type="button" role="menuitem" className="dictionary-item" onClick={() => void openOne(d.id)}>
                        <span className="name">{d.name}</span>
                        <span className="muted small">{t.kinds[d.kind]}</span>
                        <span className="muted small num">{t.menu.count(d.count)}</span>
                        <span className="unsaved small">{n > 0 ? t.menu.unsaved(n) : ""}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {folder?.reachable !== false && !(folder?.path !== null && folder?.writable === false) && (
                <button type="button" role="menuitem" className="dictionary-item new" onClick={() => setCreating(true)}>
                  {t.menu.newDictionary}
                </button>
              )}
              {folder !== null && folder.path === null && (
                <p className="dictionary-list-note">
                  {t.menu.localNote} <Link to={settingsPath("connection")}>{t.menu.setFolder}</Link>
                </p>
              )}
              {folder !== null && folder.path !== null && folder.reachable && !folder.writable && <p className="dictionary-list-note">{t.menu.readOnly}</p>}
            </>
          )}
        </div>
      )}
      {creating && (
        <NewDictionaryDialog
          onClose={() => setCreating(false)}
          onCreate={async (name) => {
            const res = await service.createDictionary(name);
            if (!res.ok) return res.message;
            setCreating(false);
            setOpen(false);
            onMessage(t.toasts.created(name), "info");
            onOpened(res.value.sheet);
            return null;
          }}
        />
      )}
    </div>
  );
}

function NewDictionaryDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<string | null> }) {
  const t = dictionaryMessages().newDialog;
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (name.trim() === "") {
      setError(t.nameEmpty);
      return;
    }
    setBusy(true);
    const err = await onCreate(name.trim());
    setBusy(false);
    if (err !== null) setError(err);
  };
  return (
    <Dialog
      title={t.title}
      onClose={onClose}
      actions={
        <>
          <Button kind="secondary" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button kind="primary" disabled={busy} onClick={() => void submit()}>
            {t.create}
          </Button>
        </>
      }
    >
      <TextInput
        id={`${id}-name`}
        labelText={t.nameLabel}
        placeholder={t.placeholder}
        value={name}
        invalid={error !== null}
        invalidText={error ?? ""}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <p className="muted small dictionary-kind-note">
        {t.kindLabel}: {t.kindAlias}
      </p>
    </Dialog>
  );
}
