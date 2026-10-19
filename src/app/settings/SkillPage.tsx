// 「Skill と辞書」の Skill のページ: 読む（本文・AI への届き方・変更履歴）、編集、AI の案を確かめて保存する。
// - 保存の前に、形・API キーらしいもの・ほかの客先の名前を橋渡しで確かめる（入力を止めてから少し後に）。
// - 開いた後にほかのメンバーが同じ Skill を保存していれば、黄色の知らせを出し、その版を見てから保存できるようにする。
// - 削除しても、変更履歴から元に戻せる（接続先の Skill は削除の印を足すだけ）。

import { Button, RadioButton, RadioButtonGroup, TextArea, TextInput } from "@carbon/react";
import { useCallback, useEffect, useId, useState } from "react";
import { Notice } from "../ui/Notice";
import { MarkdownView } from "./MarkdownView";
import { skillMessages } from "./skillMessages";
import { byteLength, shortDateTime } from "./skillFormat";
import type { SkillCheck, SkillDoc, SkillPlace, SkillsApi, SkillVersion } from "./skillsApi";

export type SkillTarget = { place: "connection" | "pc" | "default"; name: string } | { place: "draft"; name: string; draftScope: string };

export interface SkillPageProps {
  api: SkillsApi;
  /** 今の接続先（作業画面の接続先）。つないでいなければ null */
  scope: string | null;
  /** 今の接続先の名前 */
  label: string | null;
  target: SkillTarget;
  onBack: () => void;
  /** 別の Skill（保存した後の接続先の Skill など）を開く */
  onOpen: (target: SkillTarget) => void;
  notify?: (text: string, tone?: "info" | "error") => void;
}

interface Form {
  name: string;
  description: string;
  body: string;
  version: string;
}

interface EditState {
  form: Form;
  where: SkillPlace;
  /** 編集を始めたときの版（新しく作るなら null） */
  baseVersion: string | null;
  /** 案から保存する（案の置き場の印） */
  draftScope: string | null;
  /** 名前を変えられるか（新しい Skill・案） */
  nameEditable: boolean;
  /** 前からある Skill を直す */
  existing: boolean;
}

type Conflict = { kind: "conflict" | "exists"; by: string | null; at: string | null };

const BODY_MAX_BYTES = 8000;

function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "0.1.0";
}

export function SkillPage(props: SkillPageProps) {
  const { api, target } = props;
  const t = skillMessages();
  const id = useId();
  const [doc, setDoc] = useState<SkillDoc | null>(null);
  const [history, setHistory] = useState<SkillVersion[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [check, setCheck] = useState<{ check: SkillCheck; otherCustomers: string[] } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [theirs, setTheirs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const label = props.label ?? "";
  const place: SkillPlace | "default" | "draft" = target.place;

  const load = useCallback(async () => {
    setLoading(true);
    if (target.place === "draft") {
      const res = await api.getDraft(target.draftScope, target.name);
      setLoading(false);
      if (!res.ok) {
        setProblem(t.page.notFound);
        return;
      }
      const d = res.value.draft;
      const toConnection = target.draftScope !== "pc" && props.scope !== null;
      setEdit({
        form: { name: d.name, description: d.description, body: d.body, version: d.version },
        where: toConnection ? "connection" : "pc",
        baseVersion: d.basedOn,
        draftScope: target.draftScope,
        nameEditable: true,
        existing: false,
      });
      return;
    }
    const res = await api.get(target.place === "connection" ? props.scope : null, target.place, target.name);
    setLoading(false);
    if (!res.ok) {
      setProblem(t.page.notFound);
      return;
    }
    setDoc(res.value.skill);
    setHistory(res.value.history ?? []);
    setProblem(res.value.skill === null ? (res.value.problem ?? "not_found") : null);
  }, [api, target, props.scope, t.page.notFound]);

  useEffect(() => {
    void load();
  }, [load]);

  // 保存の前に確かめる（入力を止めてから 400 ms 後）
  const form = edit?.form ?? null;
  useEffect(() => {
    if (form === null) return;
    let alive = true;
    const timer = setTimeout(() => {
      void api.check(props.scope, form).then((res) => {
        if (alive && res.ok) setCheck(res.value);
      });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, props.scope, form]);

  const startEdit = () => {
    if (doc === null || place === "default" || place === "draft") return;
    setEdit({ form: { name: doc.name, description: doc.description, body: doc.body, version: bumpPatch(doc.version) }, where: place, baseVersion: doc.versionId, draftScope: null, nameEditable: false, existing: true });
    setMessage(null);
    setConflict(null);
  };

  const setForm = (patch: Partial<Form>) => setEdit((e) => (e === null ? e : { ...e, form: { ...e.form, ...patch } }));

  const save = async (force: boolean) => {
    if (edit === null) return;
    setBusy(true);
    setMessage(null);
    const res = await api.save({
      scope: edit.where === "connection" ? props.scope : null,
      place: edit.where,
      input: edit.form,
      ...(edit.where === "connection" ? { baseVersion: edit.baseVersion } : {}),
      ...(force ? { force: true } : {}),
      ...(edit.where === "pc" && (edit.existing || force) ? { overwrite: true } : {}),
      ...(edit.draftScope !== null ? { draft: edit.draftScope } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.error === "conflict" || res.error === "exists") {
        const c = (res.body?.conflict ?? null) as { by?: string; at?: string } | null;
        setConflict({ kind: res.error, by: c?.by ?? null, at: c?.at ?? null });
        return;
      }
      setMessage({ kind: "error", text: res.error === "not_writable" ? t.editor.notWritable : res.error === "unreachable" ? t.editor.unreachable : t.editor.failed(res.message) });
      return;
    }
    const saved = res.value.skill;
    props.notify?.(edit.where === "connection" ? t.editor.savedShared : t.editor.saved);
    setEdit(null);
    setConflict(null);
    setTheirs(null);
    // 保存した Skill のページを開き直す（案から保存したときは、保存先の Skill になる）
    if (target.place === "draft" || target.name !== saved.name || target.place !== edit.where) props.onOpen({ place: edit.where, name: saved.name });
    else await load();
  };

  const showTheirs = async () => {
    if (edit === null) return;
    if (theirs !== null) {
      setTheirs(null);
      return;
    }
    const res = await api.get(edit.where === "connection" ? props.scope : null, edit.where, edit.form.name);
    setTheirs(res.ok && res.value.skill !== null ? res.value.skill.body : "");
  };

  const remove = async () => {
    if (doc === null || (place !== "connection" && place !== "pc")) return;
    if (!window.confirm(t.page.removeConfirm(doc.name))) return;
    const res = await api.remove(place === "connection" ? props.scope : null, place, doc.name);
    if (!res.ok) {
      setMessage({ kind: "error", text: t.editor.failed(res.message) });
      return;
    }
    props.notify?.(t.toasts.removed(doc.name));
    props.onBack();
  };

  const revert = async (v: SkillVersion) => {
    if (place !== "connection" && place !== "pc") return;
    if (!window.confirm(t.page.revertConfirm)) return;
    const res = await api.revert(place === "connection" ? props.scope : null, place, target.name, v.id);
    if (!res.ok) {
      setMessage({ kind: "error", text: t.editor.failed(res.message) });
      return;
    }
    props.notify?.(t.toasts.restored(target.name));
    await load();
  };

  const move = async () => {
    if (doc === null || props.scope === null) return;
    if (!window.confirm(t.page.moveConfirm(doc.name, label))) return;
    let res = await api.move(props.scope, doc.name);
    if (!res.ok && res.error === "exists" && window.confirm(t.editor.exists)) res = await api.move(props.scope, doc.name, true);
    if (!res.ok) {
      setMessage({ kind: "error", text: t.editor.failed(res.message) });
      return;
    }
    props.notify?.(t.toasts.moved(doc.name));
    props.onOpen({ place: "connection", name: doc.name });
  };

  const discard = async () => {
    if (target.place !== "draft") return;
    if (!window.confirm(t.editor.discardConfirm(target.name))) return;
    await api.discard(target.draftScope, target.name);
    props.notify?.(t.toasts.discarded(target.name));
    props.onBack();
  };

  const placeText = place === "connection" ? t.page.placeConnection(label) : place === "pc" ? t.page.placePc : t.page.placeDefault;
  const delivery = place === "connection" ? t.page.deliveryConnection(label) : place === "pc" ? t.page.deliveryPc : t.page.deliveryDefault;
  const latest = history[0] ?? null;
  const deletedNow = latest !== null && latest.deleted;

  return (
    <section className="card skill-page">
      <button type="button" className="crumb-link" onClick={props.onBack}>
        ‹ {t.page.back}
      </button>
      {loading && <p className="muted">{t.loading}</p>}
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}

      {edit !== null ? (
        <SkillEditor
          id={id}
          edit={edit}
          scope={props.scope}
          label={label}
          check={check}
          conflict={conflict}
          theirs={theirs}
          busy={busy}
          isDraft={target.place === "draft"}
          onForm={setForm}
          onWhere={(where) => setEdit((e) => (e === null ? e : { ...e, where }))}
          onSave={(force) => void save(force)}
          onCancel={() => {
            if (target.place === "draft") props.onBack();
            else {
              setEdit(null);
              setConflict(null);
              setTheirs(null);
            }
          }}
          onDiscard={() => void discard()}
          onShowTheirs={() => void showTheirs()}
        />
      ) : (
        !loading && (
          <>
            <div className="skill-head">
              <div>
                <h2 className="mono">{target.name}</h2>
                {doc !== null && <p className="sk-desc-lead">{doc.description}</p>}
                <p className="muted small">
                  {placeText}
                  {doc !== null ? ` ・ ${t.page.meta(doc.version, doc.updatedBy, doc.updatedAt !== null ? shortDateTime(doc.updatedAt) : null)}` : ""}
                </p>
              </div>
              {(place === "connection" || place === "pc") && doc !== null && (
                <div className="skill-actions">
                  <Button kind="primary" size="sm" onClick={startEdit}>
                    {t.page.edit}
                  </Button>
                  {place === "pc" && props.scope !== null && (
                    <Button kind="tertiary" size="sm" onClick={() => void move()}>
                      {t.page.moveToShared(label)}
                    </Button>
                  )}
                  <Button kind="danger--ghost" size="sm" onClick={() => void remove()}>
                    {t.page.remove}
                  </Button>
                </div>
              )}
            </div>
            {problem !== null && <Notice kind="warning">{deletedNow && latest !== null ? t.page.deletedNow(latest.by, shortDateTime(latest.at)) : problem === "not_found" ? t.page.notFound : problem}</Notice>}
            <div className="skill-cols">
              <div className="skill-body">{doc !== null && <MarkdownView text={doc.body} />}</div>
              <aside className="skill-aside">
                <h3>{t.page.deliveryTitle}</h3>
                <p className="small">{delivery}</p>
                {(place === "connection" || place === "pc") && (
                  <>
                    <h3>{t.page.historyTitle}</h3>
                    {history.length === 0 ? (
                      <p className="muted small">{t.page.historyEmpty}</p>
                    ) : (
                      <ul className="plain skill-history">
                        {history.map((v, i) => (
                          <li key={v.id}>
                            <span className="small">
                              {v.by} {shortDateTime(v.at)}
                              {v.deleted ? ` ・ ${t.page.deletedMark}` : v.version !== null ? ` ・ ${v.version}` : ""}
                              {i === 0 && !v.deleted ? ` ・ ${t.page.current}` : ""}
                            </span>
                            {!v.deleted && (i > 0 || deletedNow) && (
                              <Button kind="ghost" size="sm" onClick={() => void revert(v)}>
                                {t.page.revert}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </aside>
            </div>
          </>
        )
      )}
    </section>
  );
}

function SkillEditor(p: {
  id: string;
  edit: EditState;
  scope: string | null;
  label: string;
  check: { check: SkillCheck; otherCustomers: string[] } | null;
  conflict: Conflict | null;
  theirs: string | null;
  busy: boolean;
  isDraft: boolean;
  onForm: (patch: Partial<Form>) => void;
  onWhere: (where: SkillPlace) => void;
  onSave: (force: boolean) => void;
  onCancel: () => void;
  onDiscard: () => void;
  onShowTheirs: () => void;
}) {
  const t = skillMessages().editor;
  const { form } = p.edit;
  const bytes = byteLength(form.body);
  const c = p.check?.check ?? null;
  const blocked = c !== null && (c.errors.length > 0 || c.secrets.length > 0);
  const tooLarge = bytes >= BODY_MAX_BYTES;
  const canChooseWhere = !p.edit.existing && p.scope !== null;
  return (
    <div className="skill-editor">
      {p.isDraft && (
        <div className="draft-banner">
          <span>{t.draftBanner}</span>
          <Button kind="ghost" size="sm" onClick={p.onDiscard}>
            {t.discard}
          </Button>
        </div>
      )}
      <div className="skill-cols">
        <div className="skill-form">
          <TextInput id={`${p.id}-name`} labelText={t.name} value={form.name} readOnly={!p.edit.nameEditable} onChange={(e) => p.onForm({ name: e.target.value })} className="mono" />
          <TextInput id={`${p.id}-desc`} labelText={t.description} value={form.description} maxLength={200} onChange={(e) => p.onForm({ description: e.target.value })} />
          <TextArea id={`${p.id}-body`} labelText={t.body} value={form.body} rows={18} className="skill-body-input" onChange={(e) => p.onForm({ body: e.target.value })} />
          <p className={`small ${tooLarge ? "error-text" : "muted"}`}>{t.bytes(bytes)}</p>
          {p.conflict !== null && (
            <div className="conflict-banner" role="alert">
              <span>{p.conflict.kind === "conflict" && p.conflict.by !== null && p.conflict.at !== null ? t.conflict(p.conflict.by, shortDateTime(p.conflict.at)) : t.exists}</span>
              <span className="conflict-actions">
                <Button kind="ghost" size="sm" onClick={p.onShowTheirs}>
                  {p.theirs === null ? t.showTheirs : t.hideTheirs}
                </Button>
                <Button kind="danger--tertiary" size="sm" disabled={p.busy || blocked} onClick={() => p.onSave(true)}>
                  {t.saveAnyway}
                </Button>
              </span>
            </div>
          )}
          {p.theirs !== null && <pre className="their-version">{p.theirs}</pre>}
          <div className="skill-form-actions">
            <Button kind="primary" disabled={p.busy || blocked || tooLarge || form.name.trim() === "" || form.description.trim() === "" || form.body.trim() === ""} onClick={() => p.onSave(false)}>
              {p.edit.where === "connection" ? t.saveShared : t.save}
            </Button>
            <Button kind="ghost" disabled={p.busy} onClick={p.onCancel}>
              {t.cancel}
            </Button>
          </div>
        </div>
        <aside className="skill-aside">
          <h3>{t.whereTitle}</h3>
          {canChooseWhere ? (
            <RadioButtonGroup name={`${p.id}-where`} orientation="vertical" valueSelected={p.edit.where} onChange={(v) => p.onWhere(v === "pc" ? "pc" : "connection")} legendText="">
              <RadioButton id={`${p.id}-where-c`} value="connection" labelText={t.whereConnection(p.label)} />
              <RadioButton id={`${p.id}-where-p`} value="pc" labelText={t.wherePc} />
            </RadioButtonGroup>
          ) : (
            <p className="small">{p.edit.where === "connection" ? t.whereConnection(p.label) : t.wherePc}</p>
          )}
          <h3>{t.checksTitle}</h3>
          <p className="muted small">{t.ruleSecrets}</p>
          <p className="muted small">{t.ruleOthers}</p>
          {c !== null && (
            <ul className="plain skill-checks">
              {c.secrets.map((s, i) => (
                <li key={`s${i}`} className="error-text small">
                  {t.secret(s.line, s.excerpt)}
                </li>
              ))}
              {c.errors.map((e, i) => (
                <li key={`e${i}`} className="error-text small">
                  {t.formatError}
                  {e}
                </li>
              ))}
              {(p.check?.otherCustomers.length ?? 0) > 0 && <li className="warn-text small">{t.others(p.check!.otherCustomers.join("、"))}</li>}
              {c.warnings.map((w, i) => (
                <li key={`w${i}`} className="warn-text small">
                  {t.warning}
                  {w}
                </li>
              ))}
              {c.secrets.length + c.errors.length + c.warnings.length + (p.check?.otherCustomers.length ?? 0) === 0 && <li className="muted small">{t.checkOk}</li>}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
