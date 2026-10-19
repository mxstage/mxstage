// 設定の「Skill と辞書」。
// - 置き場所（接続先ごと）: 保存した接続先と今の接続先のカード。共有フォルダを選ばなければ、ドキュメント\MX Stage\<接続先の名前>（既定）。
//   ［変える］でフォルダを選ぶ画面を開き、中身（辞書と Skill）も一緒に移す。［開く］でエクスプローラーなどで開く。
// - 今の接続先の辞書と Skill、AI の案（確かめて保存するまで使わない）、この PC だけの Skill、標準の Skill（畳んでおく）。
// - Skill を開くと、同じタブの中で Skill のページ（SkillPage.tsx）に切り替える。

import { Button, TextInput } from "@carbon/react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { DictionaryClient, type DictionarySummary, type Member } from "../dictionaries/client";
import { dictionaryMessages } from "../dictionaries/messages";
import { Notice } from "../ui/Notice";
import { settingsMessages } from "./messages";
import { skillMessages } from "./skillMessages";
import { SkillPage, type SkillTarget } from "./SkillPage";
import { SkillsApi, type PlaceInfo, type SkillDraftSummary, type SkillsListing } from "./skillsApi";
import { shortDateTime } from "./skillFormat";

export interface SkillsSectionProps {
  /** 今の接続先（保存した接続先の ID・デモの ID・Maximo の URL）。つないでいなければ null */
  currentScope: string | null;
  /** 保存した接続先（置き場所のカードに並べる） */
  saved: readonly { id: string; name: string }[];
  api?: SkillsApi;
  dictionaryClient?: DictionaryClient;
  /** 辞書を作業画面で開く（省くと［開く］を出さない） */
  openDictionary?: (name: string) => void;
  /** 終わったことを知らせる（省くと出さない） */
  notify?: (text: string, tone?: "info" | "error") => void;
}

type View = { kind: "list" } | { kind: "skill"; target: SkillTarget };

export function SkillsSection(props: SkillsSectionProps) {
  const [api] = useState(() => props.api ?? new SkillsApi());
  const [dicts] = useState(() => props.dictionaryClient ?? new DictionaryClient());
  const [view, setView] = useState<View>({ kind: "list" });
  const [listing, setListing] = useState<SkillsListing | null>(null);
  const [dictionaryList, setDictionaryList] = useState<DictionarySummary[] | null>(null);
  const [places, setPlaces] = useState<PlaceInfo[] | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const reload = useCallback(() => setSeq((n) => n + 1), []);
  const t = skillMessages();

  const scopes = useMemo(() => {
    const out: string[] = [];
    if (props.currentScope !== null) out.push(props.currentScope);
    for (const c of props.saved) if (!out.includes(c.id)) out.push(c.id);
    return out;
  }, [props.currentScope, props.saved]);

  useEffect(() => {
    let alive = true;
    void api.list(props.currentScope).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setListing(res.value);
        setError(null);
      } else setError(res.message);
    });
    if (props.currentScope !== null) {
      void dicts.list(props.currentScope).then((res) => {
        if (alive) setDictionaryList(res.ok ? res.value.dictionaries : []);
      });
    } else setDictionaryList(null);
    if (scopes.length > 0) {
      void api.places(scopes).then((res) => {
        if (!alive || !res.ok) return;
        setPlaces(res.value.places);
        setMember(res.value.member);
      });
    } else {
      setPlaces([]);
      void dicts.member().then((res) => {
        if (alive && res.ok) setMember(res.value.member);
      });
    }
    return () => {
      alive = false;
    };
  }, [api, dicts, props.currentScope, scopes, seq]);

  if (view.kind === "skill") {
    return (
      <SkillPage
        api={api}
        scope={props.currentScope}
        label={listing?.connection?.label ?? null}
        target={view.target}
        onBack={() => {
          setView({ kind: "list" });
          reload();
        }}
        onOpen={(target) => setView({ kind: "skill", target })}
        {...(props.notify ? { notify: props.notify } : {})}
      />
    );
  }

  const connection = listing?.connection ?? null;
  const label = connection?.label ?? null;
  const drafts: SkillDraftSummary[] = [...(connection?.drafts ?? []), ...(listing?.pcDrafts ?? [])];
  const defaults = listing?.skills.filter((s) => s.origin === "default") ?? [];
  const pcSkills = listing?.skills.filter((s) => s.origin === "user") ?? [];
  const problems = [...(listing?.problems ?? []), ...(connection?.problems ?? [])];
  const open = (target: SkillTarget) => setView({ kind: "skill", target });

  return (
    <section className="card skills skills-and-dictionaries">
      <h2>{t.title}</h2>
      <p className="muted">{t.intro}</p>
      {error !== null && <Notice kind="warning">{t.failed(error)}</Notice>}
      {listing === null && error === null && <p className="muted">{t.loading}</p>}

      {drafts.length > 0 && (
        <div className="skill-drafts" data-testid="skill-drafts">
          <h3>{t.drafts.title}</h3>
          <p className="muted small">{t.drafts.help}</p>
          <ul className="plain sk-list">
            {drafts.map((d) => (
              <li key={`${d.draftScope}/${d.name}`} className="sk-row">
                <code className="mono">{d.name}</code>
                <span className="sk-desc">
                  {d.description} <span className="draft-tag">{t.drafts.tag}</span>
                </span>
                <span className="muted small">{d.draftScope === "pc" ? t.drafts.noConnection : t.drafts.at(shortDateTime(d.createdAt))}</span>
                <Button kind="primary" size="sm" onClick={() => open({ place: "draft", name: d.name, draftScope: d.draftScope })}>
                  {t.drafts.review}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>{t.places.title}</h3>
      <p className="muted small">{t.places.help}</p>
      {member !== null && <MemberName member={member} client={dicts} onSaved={setMember} />}
      {places !== null && places.length === 0 && <p className="muted small">{t.places.empty}</p>}
      {places?.map((p) => (
        <PlaceCard key={p.scope} place={p} current={p.scope === props.currentScope} client={dicts} onChanged={reload} />
      ))}

      {props.currentScope === null ? (
        <p className="muted">{t.skills.notConnected}</p>
      ) : (
        <>
          <h3>{t.dictionaries.title(label ?? "")}</h3>
          {dictionaryList !== null && dictionaryList.length === 0 && <p className="muted small">{t.dictionaries.empty}</p>}
          <ul className="plain sk-list">
            {(dictionaryList ?? []).map((d) => (
              <li key={d.id} className="sk-row">
                <span className="sk-name">{d.name}</span>
                <span className="muted small">
                  {dictionaryMessages().kinds[d.kind]} ・ {t.dictionaries.entries(d.count)}
                </span>
                <span className="muted small">{d.updatedBy !== null && d.updatedAt !== null ? `${d.updatedBy} ${shortDateTime(d.updatedAt)}` : ""}</span>
                {props.openDictionary && (
                  <Button kind="ghost" size="sm" title={t.dictionaries.openHelp} onClick={() => props.openDictionary?.(d.name)}>
                    {t.dictionaries.open}
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <h3>{t.skills.title(label ?? "")}</h3>
          {connection !== null && connection.skills.length === 0 && <p className="muted small">{t.skills.empty}</p>}
          <ul className="plain sk-list">
            {(connection?.skills ?? []).map((s) => (
              <li key={s.name} className="sk-row">
                <code className="mono">{s.name}</code>
                <span className="sk-desc">{s.description}</span>
                <span className="muted small">{s.updatedBy !== null && s.updatedAt !== null ? `${s.updatedBy} ${shortDateTime(s.updatedAt)}` : ""}</span>
                <Button kind="ghost" size="sm" onClick={() => open({ place: "connection", name: s.name })}>
                  {t.skills.open}
                </Button>
              </li>
            ))}
          </ul>
          {connection !== null && connection.deleted.length > 0 && (
            <details className="sk-collapsed">
              <summary>{t.skills.deleted(connection.deleted.length)}</summary>
              <ul className="plain sk-list">
                {connection.deleted.map((d) => (
                  <li key={d.name} className="sk-row">
                    <code className="mono">{d.name}</code>
                    <span className="muted small">{t.skills.deletedAt(d.by, shortDateTime(d.at))}</span>
                    <Button kind="ghost" size="sm" onClick={() => open({ place: "connection", name: d.name })}>
                      {t.skills.open}
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <h3>{t.skills.pcTitle}</h3>
      <p className="muted small">{t.skills.pcHelp}</p>
      {listing !== null && pcSkills.length === 0 && <p className="muted small">{t.skills.pcEmpty}</p>}
      <ul className="plain sk-list">
        {pcSkills.map((s) => (
          <li key={s.name} className="sk-row">
            <code className="mono">{s.name}</code>
            <span className="sk-desc">{s.description}</span>
            <span className="muted small">{s.version ? settingsMessages().skills.version(s.version).trim() : ""}</span>
            <Button kind="ghost" size="sm" onClick={() => open({ place: "pc", name: s.name })}>
              {t.skills.open}
            </Button>
          </li>
        ))}
      </ul>

      {defaults.length > 0 && (
        <details className="sk-collapsed sk-builtins">
          <summary>
            {t.skills.builtIn(defaults.length)} <span className="muted small">{t.skills.builtInHelp}</span>
          </summary>
          {(
            [
              ["index", settingsMessages().skills.groupIndex],
              ["core", settingsMessages().skills.groupCore],
              ["object", settingsMessages().skills.groupObject],
            ] as const
          ).map(([category, groupLabel]) => {
            const items = defaults.filter((s) => s.category === category);
            return items.length === 0 ? null : (
              <div key={category} className="skill-group">
                <h4>{groupLabel}</h4>
                <ul className="plain sk-list">
                  {items.map((s) => (
                    <li key={s.name} className="sk-row">
                      <code className="mono">{s.name}</code>
                      <span className="sk-desc">{t.builtIns[s.name] ?? s.description}</span>
                      <span className="muted small">{s.version ? settingsMessages().skills.version(s.version).trim() : ""}</span>
                      <Button kind="ghost" size="sm" onClick={() => open({ place: "default", name: s.name })}>
                        {t.skills.open}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </details>
      )}

      {problems.length > 0 && (
        <ul className="plain skill-problems">
          {problems.map((p, i) => (
            <li key={i}>
              <Notice kind={p.level === "error" ? "error" : "warning"}>
                {p.name !== "" && <code className="mono">{p.name}</code>} {p.level === "error" ? t.skills.problemError : t.skills.problemWarn}
                {p.message}
              </Notice>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** この PC の利用者の名前（メンバーに見せる名前。辞書と Skill の変更履歴に出る） */
function MemberName({ member, client, onSaved }: { member: Member; client: DictionaryClient; onSaved: (m: Member) => void }) {
  const t = dictionaryMessages().folder;
  const id = useId();
  const [text, setText] = useState(member.name);
  useEffect(() => setText(member.name), [member.name]);
  return (
    <div className="shared-folder-member">
      <TextInput id={`${id}-member`} labelText={t.memberName} helperText={t.memberHelp} value={text} onChange={(e) => setText(e.target.value)} size="sm" />
      <Button
        kind="tertiary"
        size="sm"
        disabled={text.trim() === "" || text.trim() === member.name}
        onClick={() =>
          void client.setMemberName(text).then((res) => {
            if (res.ok) onSaved(res.value.member);
          })
        }
      >
        {t.memberSave}
      </Button>
    </div>
  );
}

/** 接続先 1 つの置き場所 */
function PlaceCard({ place, current, client, onChanged }: { place: PlaceInfo; current: boolean; client: DictionaryClient; onChanged: () => void }) {
  const t = skillMessages().places;
  const f = dictionaryMessages().folder;
  const sync = dictionaryMessages().sync;
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const folder = place.folder;
  const isDefault = folder.isDefault ?? folder.path === null;
  const shownPath = isDefault ? (folder.root ?? "") : (folder.path ?? "");
  const tag = isDefault ? t.defaultTag : folder.sync !== null ? sync[folder.sync] : null;
  const rootSync = isDefault && folder.rootSync && folder.rootSync !== "local" ? t.syncedBy(sync[folder.rootSync]) : null;
  const counts = [
    isDefault ? t.thisPc : t.shared,
    ...(place.dictionaries !== null ? [t.dictionaries(place.dictionaries)] : []),
    ...(place.skills !== null ? [t.skills(place.skills)] : []),
    ...(!isDefault && place.members !== null ? [t.members(place.members)] : []),
  ];

  const errorText = (code: string, message: string) =>
    code === "invalid_folder" ? f.errors.invalid_folder : code === "not_writable" ? f.errors.not_writable : code === "unreachable" ? f.errors.unreachable : f.errors.other(message);

  const use = async (chosen: string) => {
    setBusy(true);
    const res = await client.setFolder(place.scope, chosen, { name: place.label, connections: [] });
    setBusy(false);
    if (!res.ok) {
      setNote({ kind: "error", text: errorText(res.error, res.message) });
      return;
    }
    setTyping(false);
    setNote({ kind: "info", text: t.changed });
    onChanged();
  };

  const choose = async () => {
    setNote({ kind: "info", text: f.picking });
    setBusy(true);
    const res = await client.pickFolder();
    setBusy(false);
    if (!res.ok) {
      setNote({ kind: "error", text: f.pickUnsupported });
      setTyping(true);
      return;
    }
    setNote(null);
    if (res.value.path !== null) await use(res.value.path);
  };

  return (
    <div className={`place-card${current ? " current" : ""}`} data-scope={place.scope}>
      <div className="place-head">
        <strong>{place.label}</strong>
        {current && <span className="saved-current">{t.inUse}</span>}
      </div>
      <div className="shared-folder-row">
        <span className="shared-folder-label">{t.label}</span>
        <span className="shared-folder-path">
          <span className="mono small">{shownPath}</span>
          {tag !== null && <span className={`sync-tag${isDefault ? " default" : ""}`}>{tag}</span>}
          {rootSync !== null && <span className="muted small">{rootSync}</span>}
          <span className="muted small place-counts">{counts.join(" ・ ")}</span>
        </span>
        <span className="shared-folder-actions">
          <Button kind="ghost" size="sm" disabled={busy || !folder.reachable} onClick={() => void client.openFolder(place.scope)}>
            {t.open}
          </Button>
          <Button kind="ghost" size="sm" disabled={busy} onClick={() => void choose()}>
            {t.change}
          </Button>
        </span>
      </div>
      {!folder.reachable && <p className="small error-text">{f.unreachable}</p>}
      {folder.reachable && !folder.writable && <p className="small muted">{f.readOnly}</p>}
      {!isDefault && folder.sync === "local" && <p className="small muted">{f.notShared}</p>}
      {note !== null && <p className={`small ${note.kind === "error" ? "error-text" : "muted"}`}>{note.text}</p>}
      {typing && (
        <div className="shared-folder-typed">
          <TextInput id={`${id}-path`} labelText={f.pathLabel} placeholder={f.pathPlaceholder} value={path} onChange={(e) => setPath(e.target.value)} size="sm" />
          <Button kind="tertiary" size="sm" disabled={busy || path.trim() === ""} onClick={() => void use(path.trim())}>
            {f.usePath}
          </Button>
        </div>
      )}
    </div>
  );
}
