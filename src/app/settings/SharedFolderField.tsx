// 設定の「接続」: 接続先の共有フォルダ（客先の辞書と Skill をメンバーと共有する置き場）。
// - フォルダを選ぶ画面は橋渡しが開く（ブラウザはフォルダの場所を教えてくれないため）。開けない PC では場所を入れる。
// - OneDrive・SharePoint などで同期しているかを札で出す。同期していないフォルダなら一言そう出す（止めはしない）。
// - full: 今の接続先の欄（メンバーに見せる名前も直せる）。compact: 保存した接続先の一覧の 1 行。

import { Button, TextInput } from "@carbon/react";
import { useCallback, useEffect, useId, useState } from "react";
import { DictionaryClient, type FolderInfo, type Member, type ProjectInfo } from "../dictionaries/client";
import { dictionaryMessages } from "../dictionaries/messages";
import { Notice } from "../ui/Notice";

export interface SharedFolderFieldProps {
  /** 接続先（保存した接続先の ID・デモの ID・保存していない接続先の Maximo の URL） */
  scope: string;
  project: ProjectInfo;
  compact?: boolean;
  client?: DictionaryClient;
}

export function SharedFolderField({ scope, project, compact = false, client: given }: SharedFolderFieldProps) {
  const t = dictionaryMessages().folder;
  const sync = dictionaryMessages().sync;
  const id = useId();
  const [client] = useState(() => given ?? new DictionaryClient());
  const [folder, setFolder] = useState<FolderInfo | null>(null);
  const [count, setCount] = useState(0);
  const [member, setMember] = useState<Member | null>(null);
  const [memberText, setMemberText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");

  const load = useCallback(async () => {
    const res = await client.list(scope);
    if (!res.ok) return;
    setFolder(res.value.folder);
    setCount(res.value.dictionaries.length);
    setMember(res.value.member);
    setMemberText((cur) => (cur === "" ? res.value.member.name : cur));
  }, [client, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const errorText = (code: string, message: string) =>
    code === "invalid_folder" ? t.errors.invalid_folder : code === "not_writable" ? t.errors.not_writable : code === "unreachable" ? t.errors.unreachable : t.errors.other(message);

  const use = async (chosen: string) => {
    setBusy(true);
    const res = await client.setFolder(scope, chosen, project);
    setBusy(false);
    if (!res.ok) {
      setNote({ kind: "error", text: errorText(res.error, res.message) });
      return;
    }
    setTyping(false);
    setNote({ kind: "info", text: t.set });
    await load();
  };

  const choose = async () => {
    setNote({ kind: "info", text: t.picking });
    setBusy(true);
    const res = await client.pickFolder();
    setBusy(false);
    if (!res.ok) {
      setNote({ kind: "error", text: t.pickUnsupported });
      setTyping(true);
      return;
    }
    setNote(null);
    if (res.value.path !== null) await use(res.value.path);
  };

  const stop = async () => {
    if (!window.confirm(t.stopConfirm)) return;
    setBusy(true);
    await client.setFolder(scope, null);
    setBusy(false);
    setNote(null);
    await load();
  };

  const saveName = async () => {
    const res = await client.setMemberName(memberText);
    if (res.ok) setMember(res.value.member);
  };

  if (folder === null) return null;
  const syncLabel = folder.path !== null && folder.sync !== null ? sync[folder.sync] : null;
  const status =
    folder.path === null ? (
      <span>
        {t.none}
        <span className="muted small"> · {t.noneHelp}</span>
      </span>
    ) : (
      <span className="shared-folder-path">
        <span className="mono small">{folder.path}</span>
        {syncLabel !== null && <span className="sync-tag">{syncLabel}</span>}
        <span className="muted small"> · {t.stats(count)}</span>
      </span>
    );
  const actions = (
    <span className="shared-folder-actions">
      <Button kind="ghost" size="sm" disabled={busy} onClick={() => void choose()}>
        {folder.path === null ? t.choose : t.change}
      </Button>
      {folder.path !== null && folder.reachable && (
        <Button kind="ghost" size="sm" disabled={busy} onClick={() => void client.openFolder(scope)}>
          {t.open}
        </Button>
      )}
      {folder.path !== null && !compact && (
        <Button kind="ghost" size="sm" disabled={busy} onClick={() => void stop()}>
          {t.stop}
        </Button>
      )}
    </span>
  );

  return (
    <div className={`shared-folder${compact ? " compact" : ""}`}>
      <div className="shared-folder-row">
        <span className="shared-folder-label">{t.label}</span>
        {status}
        {actions}
      </div>
      {folder.path !== null && !folder.reachable && <p className="small error-text">{t.unreachable}</p>}
      {folder.path !== null && folder.reachable && !folder.writable && <p className="small muted">{t.readOnly}</p>}
      {folder.path !== null && folder.sync === "local" && <p className="small muted">{t.notShared}</p>}
      {note !== null && (compact ? <p className={`small ${note.kind === "error" ? "error-text" : "muted"}`}>{note.text}</p> : <Notice kind={note.kind === "error" ? "error" : "info"}>{note.text}</Notice>)}
      {typing && (
        <div className="shared-folder-typed">
          <TextInput id={`${id}-path`} labelText={t.pathLabel} placeholder={t.pathPlaceholder} value={path} onChange={(e) => setPath(e.target.value)} size="sm" />
          <Button kind="tertiary" size="sm" disabled={busy || path.trim() === ""} onClick={() => void use(path.trim())}>
            {t.usePath}
          </Button>
        </div>
      )}
      {!compact && member !== null && (
        <div className="shared-folder-member">
          <TextInput id={`${id}-member`} labelText={t.memberName} helperText={t.memberHelp} value={memberText} onChange={(e) => setMemberText(e.target.value)} size="sm" />
          <Button kind="tertiary" size="sm" disabled={memberText.trim() === "" || memberText.trim() === member.name} onClick={() => void saveName()}>
            {t.memberSave}
          </Button>
        </div>
      )}
    </div>
  );
}
