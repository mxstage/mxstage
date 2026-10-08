// API 設定画面 /settings（トップレベルのページ。iframe に入れない）。
// Maximo への接続は、パスワードマネージャーが保存を検知できる標準のログインフォームの形にする。
// API キーの入力欄は React の state に持たない（非制御の入力欄から読んで Web Worker に渡し、すぐ空にする）。
// 節はタブに分ける（接続・デモ・ライセンス・AI アシスタント・Skill・更新・言語）。選んだタブは URL のハッシュ（/settings#license）に出す。
// タブを切り替えても各節は描いたまま（隠すだけ）にして、入力途中の値を失わない。

import { Button, Checkbox, Form, Layer, RadioButton, RadioButtonGroup, Select, SelectItem, Tab, TabList, TabPanel, TabPanels, Tabs, TextInput } from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { LOCALES, getLocale, isLocale, subscribeLocale } from "../../shared/i18n";
import type { AutoConnector } from "../connections/auto";
import type { SavedConnection, SavedConnectionsClient, SaveProblem } from "../connections/client";
import type { DemoApi } from "../demo/client";
import { demoMessages } from "../demo/messages";
import type { ConnectInput, VaultView } from "../keyvault/client";
import type { Environment, LicenseClient } from "../license/client";
import { licenseMessages } from "../license/messages";
import type { MaximoVia } from "../maximo/client";
import { pastStatusOf, setPastStatus, type PastStatus } from "../maximo/statusPrefs";
import { hostOf } from "../pages/status";
import type { MaximoConnectionInfo } from "../runtime/contracts";
import { Link, spaClick } from "../ui/Link";
import { chooseLocale } from "../ui/locale";
import { Notice } from "../ui/Notice";
import { APP_PATH, NAVIGATE_EVENT, settingsPath, settingsTabOf, type SettingsTab } from "../ui/routes";
import { DemoSection } from "./DemoSection";
import { LicenseSection } from "./LicenseSection";
import { UpdatesSection } from "./UpdatesSection";
import type { UpdatesApi } from "./updates";
import { LANGUAGE_NAMES, settingsMessages as m } from "./messages";
import {
  connectErrorMessage,
  fetchSkillList,
  isVia,
  loadSavedSettings,
  localClientStatus,
  normalizeBaseUrl,
  saveSettings,
  validateSettingsForm,
  viaOptionLabel,
  type SettingsFormErrors,
  type SkillList,
  type StorageLike,
} from "./logic";

export interface SettingsVault {
  connect(input: ConnectInput): Promise<MaximoConnectionInfo>;
  getView(): VaultView;
  subscribe(listener: () => void): () => void;
  disconnect(): void;
}

export interface PasswordCredentialSupport {
  /** PasswordCredential を作る。作れなければ null */
  create(id: string, password: string): unknown;
  store(credential: unknown): Promise<unknown>;
}

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export interface SettingsPageProps {
  vault: SettingsVault;
  /** 省略時は localStorage */
  storage?: StorageLike | null;
  /** 省略時はブラウザの PasswordCredential（使えなければ null） */
  passwordCredential?: PasswordCredentialSupport | null;
  /** 接続に成功したときの history.replaceState */
  replaceUrl?: (url: string) => void;
  clipboard?: ClipboardLike | null;
  /** Skill の一覧を読む（省略時は橋渡しの /_mxstage/skills） */
  loadSkills?: () => Promise<SkillList>;
  /** ライセンスキーと接続先ごとの環境（本番／テスト）。省くとライセンスの節と環境の選択を出さない */
  license?: LicenseClient;
  /** 橋渡しに保存した接続先。省くと保存の機能を出さない（API キーはこのタブのメモリだけ） */
  connections?: SavedConnectionsClient | null;
  /** 保存した接続先への接続（connections と一緒に渡す） */
  autoConnect?: AutoConnector | null;
  /** 更新の窓口（省くと橋渡しの /_mxstage/updates） */
  updates?: UpdatesApi;
  /** デモの窓口（省くと橋渡しの /_mxstage/demo） */
  demo?: DemoApi;
}

/** 接続に成功したら、この URL に replaceState する（パスワードマネージャーの保存検知のため URL を変える） */
export const CONNECTED_URL = "/settings?connected=1";

export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function browserPasswordCredential(): PasswordCredentialSupport | null {
  const g = globalThis as unknown as {
    PasswordCredential?: new (data: { id: string; password: string; name?: string }) => unknown;
    navigator?: { credentials?: { store?: (c: unknown) => Promise<unknown> } };
  };
  const Ctor = g.PasswordCredential;
  const credentials = g.navigator?.credentials;
  if (typeof Ctor !== "function" || !credentials || typeof credentials.store !== "function") return null;
  const store = credentials.store.bind(credentials);
  return {
    create: (id, password) => {
      try {
        return new Ctor({ id, password, name: id });
      } catch {
        return null;
      }
    },
    store: (c) => store(c),
  };
}

function browserClipboard(): ClipboardLike | null {
  try {
    const c = navigator.clipboard;
    return c && typeof c.writeText === "function" ? c : null;
  } catch {
    return null;
  }
}

/** 今の URL のハッシュが指す設定のタブ（無ければ null） */
function tabFromLocation(): SettingsTab | null {
  try {
    return settingsTabOf(window.location.hash);
  } catch {
    return null;
  }
}

/** 選んだタブを URL のハッシュに出す。履歴は積まない（戻るで作業画面に戻れるように） */
function writeTabToLocation(tab: SettingsTab): void {
  try {
    const { pathname, search, hash } = window.location;
    if (hash === `#${tab}`) return;
    window.history.replaceState(window.history.state, "", `${pathname}${search}#${tab}`);
  } catch {
    // URL を書けなくてもタブは切り替わる
  }
}

/**
 * 選んでいるタブ。初めは URL のハッシュ、無ければ「接続」。
 * ハッシュが外から変わったとき（リンク・戻る・手で書き換え）も追う。
 */
function useSelectedTab(): [SettingsTab | null, (tab: SettingsTab) => void] {
  const [tab, setTab] = useState<SettingsTab | null>(tabFromLocation);
  useEffect(() => {
    const sync = () => setTab(tabFromLocation());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);
  const select = useCallback((next: SettingsTab) => {
    setTab(next);
    writeTabToLocation(next);
  }, []);
  return [tab, select];
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : m().page.failed;
}

export function SettingsPage(props: SettingsPageProps) {
  const { vault } = props;
  const storage = props.storage === undefined ? browserStorage() : props.storage;
  const passwordCredential = props.passwordCredential === undefined ? browserPasswordCredential() : props.passwordCredential;
  const replaceUrl = props.replaceUrl ?? ((url: string) => window.history.replaceState(window.history.state, "", url));
  const clipboard = props.clipboard === undefined ? browserClipboard() : props.clipboard;

  const subscribe = useCallback((l: () => void) => vault.subscribe(l), [vault]);
  const getView = useCallback(() => vault.getView(), [vault]);
  const view = useSyncExternalStore(subscribe, getView);
  // 描画のたびに作り直すと、一覧の読み込みが繰り返されるので固定する
  const loadSkills = useMemo(() => props.loadSkills ?? (() => fetchSkillList()), [props.loadSkills]);

  const [requested, selectTab] = useSelectedTab();

  const t = m().page;
  const tabs = m().tabs;
  // ライセンスの節は license を渡したときだけ（null を挟むと Carbon のタブの番号がずれるので、配列から外す）
  const sections: { id: SettingsTab; label: string; content: ReactNode }[] = [
    {
      id: "connection",
      label: tabs.connection,
      content: (
        <MaximoSection
          vault={vault}
          view={view}
          storage={storage}
          passwordCredential={passwordCredential}
          replaceUrl={replaceUrl}
          license={props.license ?? null}
          saved={props.connections && props.autoConnect ? { client: props.connections, auto: props.autoConnect } : null}
        />
      ),
    },
    {
      id: "demo",
      label: demoMessages().tab,
      content: (
        <DemoSection
          vault={vault}
          connections={props.connections ?? null}
          autoConnect={props.autoConnect ?? null}
          {...(props.demo ? { api: props.demo } : {})}
        />
      ),
    },
    ...(props.license ? [{ id: "license" as const, label: licenseMessages().section.title, content: <LicenseSection license={props.license} /> }] : []),
    { id: "assistants", label: tabs.assistants, content: <LlmSection clipboard={clipboard} /> },
    { id: "skills", label: tabs.skills, content: <SkillsSection load={loadSkills} /> },
    { id: "updates", label: tabs.updates, content: <UpdatesSection {...(props.updates ? { api: props.updates } : {})} /> },
    { id: "language", label: m().language.title, content: <LanguageSection storage={storage} /> },
  ];
  // URL が指すタブが無ければ（知らない名前・ライセンスの節が無い）、初めの「接続」
  const found = sections.findIndex((s) => s.id === requested);
  const selectedIndex = found >= 0 ? found : 0;

  return (
    <main className="page settings">
      <header className="page-head">
        <h1>{t.title}</h1>
        <Button kind="tertiary" size="md" href={APP_PATH} onClick={spaClick(APP_PATH)}>
          {t.backToApp}
        </Button>
      </header>
      <Tabs
        selectedIndex={selectedIndex}
        onChange={({ selectedIndex: i }) => {
          const next = sections[i];
          if (next) selectTab(next.id);
        }}
      >
        <TabList aria-label={tabs.label} className="settings-tabs">
          {sections.map((s) => (
            <Tab key={s.id} data-tab={s.id}>
              {s.label}
            </Tab>
          ))}
        </TabList>
        <TabPanels>
          {/* 各パネルの名前はタブ（aria-labelledby）。中の節にも見出し（h2）がある */}
          {sections.map((s) => (
            <TabPanel key={s.id} data-tab={s.id} className="settings-panel">
              {s.content}
            </TabPanel>
          ))}
        </TabPanels>
      </Tabs>
    </main>
  );
}

/**
 * Skill（作業手順書）の一覧。アプリ既定と利用者の Skill を分けて出す。
 * - アプリ既定: MX Stage と一緒に入り、更新で置き換わる。書き換えない。
 * - 利用者の Skill: 業務や客先ごとの手順。利用者のフォルダに置き、MX Stage を更新しても残る。
 */
function SkillsSection({ load }: { load: () => Promise<SkillList> }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ok"; list: SkillList } | { kind: "error"; message: string }>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    load().then(
      (list) => {
        if (alive) setState({ kind: "ok", list });
      },
      (e: unknown) => {
        if (alive) setState({ kind: "error", message: errorText(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [load]);

  const defaults = state.kind === "ok" ? state.list.skills.filter((s) => s.origin === "default") : [];
  const users = state.kind === "ok" ? state.list.skills.filter((s) => s.origin === "user") : [];
  const problems = state.kind === "ok" ? state.list.problems : [];
  const t = m().skills;
  return (
    <section className="card skills">
      <h2>{t.title}</h2>
      <p className="muted">{t.intro}</p>
      {state.kind === "loading" && <p className="muted">{t.loading}</p>}
      {state.kind === "error" && <Notice kind="warning">{state.message}</Notice>}
      {state.kind === "ok" && (
        <>
          <h3>{t.defaultsTitle}</h3>
          <p className="muted small">{t.defaultsHelp}</p>
          {defaults.some((s) => typeof s.category === "string") ? (
            // 層ごとに分ける（目次・基本動作・標準オブジェクト）。層を返さない古い橋渡しなら 1 つの一覧
            (
              [
                ["index", t.groupIndex],
                ["core", t.groupCore],
                ["object", t.groupObject],
              ] as const
            ).map(([category, label]) => {
              const items = defaults.filter((s) => s.category === category);
              return items.length === 0 ? null : (
                <div key={category} className="skill-group">
                  <h4>{label}</h4>
                  <SkillItems items={items} empty={t.defaultsEmpty} />
                </div>
              );
            })
          ) : (
            <SkillItems items={defaults} empty={t.defaultsEmpty} />
          )}
          <h3>{t.userTitle}</h3>
          <p className="muted small">
            {t.userIntro}
            {state.list.userSkillsDir !== null ? (
              <>
                {" "}
                {t.userPlaceBefore}
                <code className="mono">{state.list.userSkillsDir}</code>
                {t.userPlaceMiddle}
                <code className="mono">&lt;{t.userPlaceName}&gt;/SKILL.md</code>
                {t.userPlaceAfter}
              </>
            ) : null}
            {t.userKeep}
          </p>
          <SkillItems items={users} empty={t.userEmpty} />
          {problems.length > 0 && (
            <ul className="plain skill-problems">
              {problems.map((p, i) => (
                <li key={i}>
                  <Notice kind={p.level === "error" ? "error" : "warning"}>
                    {p.name !== "" && <code className="mono">{p.name}</code>} {p.level === "error" ? t.problemError : t.problemWarn}
                    {p.message}
                  </Notice>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SkillItems({ items, empty }: { items: SkillList["skills"]; empty: string }) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="plain skill-list">
      {items.map((s) => (
        <li key={s.name}>
          <code className="mono">{s.name}</code>
          {s.version && <span className="muted small">{m().skills.version(s.version)}</span>}
          <p className="muted small">{s.description}</p>
        </li>
      ))}
    </ul>
  );
}

interface MaximoSectionProps {
  vault: SettingsVault;
  view: VaultView;
  storage: StorageLike | null;
  passwordCredential: PasswordCredentialSupport | null;
  replaceUrl: (url: string) => void;
  license: LicenseClient | null;
  saved: SavedSupport | null;
}

interface SavedSupport {
  client: SavedConnectionsClient;
  auto: AutoConnector;
}

function savedProblemText(problem: SaveProblem): string {
  return m().saved.problem[problem] ?? m().page.failed;
}

function MaximoSection({ vault, view, storage, passwordCredential, replaceUrl, license, saved: savedSupport }: MaximoSectionProps) {
  const saved = useMemo(() => loadSavedSettings(storage), [storage]);
  const [baseUrl, setBaseUrl] = useState(view.kind === "disconnected" ? saved.baseUrl : view.info.baseUrl);
  const [via, setVia] = useState<MaximoVia>(view.kind === "disconnected" ? saved.via : view.info.via);
  const [connectionName, setConnectionName] = useState(view.kind === "disconnected" ? "" : view.info.connectionName);
  // 接続先ごとの環境（本番／テスト）。前に選んだものを初めから選んでおく
  const [environment, setEnvironment] = useState<Environment | null>(() => license?.declared(view.kind === "disconnected" ? saved.baseUrl : view.info.baseUrl) ?? null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const licensed = license?.licenseFor(normalizeBaseUrl(baseUrl)) ?? null;
  const [errors, setErrors] = useState<SettingsFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(view.kind !== "connected");
  // 保存した接続先（橋渡しが API キーを預かる）。使えるときは「この PC に保存する」を初めから選んでおく
  const savedSnapshot = useSyncExternalStore(
    useCallback((l: () => void) => savedSupport?.client.subscribe(l) ?? (() => undefined), [savedSupport]),
    useCallback(() => savedSupport?.client.snapshot() ?? null, [savedSupport]),
  );
  const canSave = savedSupport !== null && savedSnapshot !== null && savedSnapshot.status !== "unavailable";
  const [saveOnPc, setSaveOnPc] = useState(true);
  const [editing, setEditing] = useState<SavedConnection | null>(null);
  const willSave = canSave && saveOnPc && via === "proxy";
  const keyRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ロック・切断されたらフォームに戻す。自動でつながったら（保存した接続先）接続の情報を出す
  useEffect(() => {
    setShowForm(view.kind !== "connected");
  }, [view.kind]);

  const startEdit = (c: SavedConnection) => {
    setEditing(c);
    setConnectionName(c.name);
    setBaseUrl(c.baseUrl);
    setVia("proxy");
    setSaveOnPc(true);
    setEnvironment(c.environment ?? license?.declared(c.baseUrl) ?? null);
    setErrors({});
    setFailure(null);
    setShowForm(true);
  };

  /** 保存してからつなぐ（API キーは入力欄から橋渡しへ 1 回だけ送り、すぐ入力欄を空にする） */
  const saveAndConnect = async (support: SavedSupport, keyInput: HTMLInputElement, name: string, url: string) => {
    const apiKey = keyInput.value;
    keyInput.value = "";
    const editingId = editing?.id;
    setBusy(true);
    try {
      const out = await support.client.save({
        ...(editingId !== undefined ? { id: editingId } : {}),
        name,
        baseUrl: url,
        environment: licensed !== null ? "production" : environment,
        ...(apiKey !== "" ? { apiKey } : {}),
      });
      if (!out.ok) {
        if (mounted.current) setFailure(savedProblemText(out.problem));
        return;
      }
      try {
        await support.auto.connect(out.connection);
      } catch (err) {
        // 新しく保存した接続先が通らなければ、残さない（直したときは残して、もう一度直せるようにする）
        if (editingId === undefined) await support.client.remove(out.connection.id);
        if (mounted.current) {
          setFailure(connectErrorMessage(err, "proxy"));
          keyRef.current?.focus();
        }
        return;
      }
      saveSettings(storage, { baseUrl: url, via: "proxy" });
      if (license !== null && licensed === null && environment !== null) license.declare(url, environment);
      replaceUrl(CONNECTED_URL);
      if (mounted.current) {
        setEditing(null);
        setShowForm(false);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const keyInput = keyRef.current;
    if (!keyInput) return;
    const name = connectionName.trim();
    const url = normalizeBaseUrl(baseUrl);
    const found = validateSettingsForm({ baseUrl: url, via, connectionName: name, apiKey: keyInput.value });
    // 保存した接続先を直すときは、API キーを空にすれば保存してあるキーのまま
    if (willSave && editing !== null && keyInput.value === "") delete found.apiKey;
    setErrors(found);
    setFailure(null);
    // 環境は必ず選ぶ（ライセンスキーに書かれた接続先はいつも本番なので選ばなくてよい）
    const needsEnvironment = license !== null && licensed === null && environment === null;
    setEnvironmentError(needsEnvironment ? licenseMessages().environment.required : null);
    if (Object.keys(found).length > 0 || needsEnvironment) return;
    if (willSave && savedSupport !== null) {
      await saveAndConnect(savedSupport, keyInput, name, url);
      return;
    }

    // パスワードマネージャーへの保存（Chromium 系）は whoami の成功後に行うため、資格情報のオブジェクトだけ先に作る。
    // 【これが無いと成功後に保存できない。PasswordCredential が無いブラウザではキーはここで手放す】
    const credential = passwordCredential ? passwordCredential.create(name, keyInput.value) : null;
    // キーは入力欄から直接 Worker へ渡し、すぐ入力欄を空にする（変数に残さない）
    const pending = vault.connect({ baseUrl: url, via, connectionName: name, apiKey: keyInput.value });
    keyInput.value = "";
    setBusy(true);
    try {
      await pending;
      saveSettings(storage, { baseUrl: url, via });
      if (license !== null && licensed === null && environment !== null) license.declare(url, environment);
      if (credential !== null && credential !== undefined && passwordCredential) {
        passwordCredential.store(credential).catch(() => undefined);
      }
      replaceUrl(CONNECTED_URL);
      if (mounted.current) setShowForm(false);
    } catch (err) {
      if (mounted.current) {
        setFailure(connectErrorMessage(err, via));
        keyRef.current?.focus();
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const t = m().maximo;
  const s = m().saved;
  const savedList =
    savedSupport !== null && savedSnapshot !== null && savedSnapshot.status !== "unavailable" ? (
      <SavedConnections
        support={savedSupport}
        connections={savedSnapshot.connections}
        protection={savedSnapshot.protection}
        currentId={view.kind === "connected" ? (view.info.savedId ?? null) : null}
        onEdit={startEdit}
        formFailure={failure}
      />
    ) : null;
  const disconnect = () => (savedSupport !== null ? savedSupport.auto.disconnect() : vault.disconnect());
  if (!showForm && view.kind === "connected") {
    return (
      <section className="card">
        <h2>{t.title}</h2>
        <ConnectedInfo info={view.info} license={license} onReconnect={() => setShowForm(true)} onDisconnect={disconnect} />
        <PastStatusField baseUrl={view.info.baseUrl} storage={storage} />
        {savedList}
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{t.title}</h2>
      {view.kind === "locked" && <Notice kind="warning">{view.reason === "idle" ? t.lockedIdle : t.lockedManual}</Notice>}
      {savedList}
      <p className="muted small demo-hint">
        <Link to={settingsPath("demo")}>{demoMessages().noMaximoHint}</Link>
      </p>
      {editing !== null && <Notice kind="info">{s.editing(editing.name)}</Notice>}
      {!canSave ? <p className="muted">{t.keyNote}</p> : !willSave ? <p className="muted">{s.unsavedKeyNote}</p> : null}
      {/* カードは layer-01 の面。入力欄は一段上の面の色で描く */}
      <Layer>
        <Form className="connect-form" onSubmit={onSubmit} noValidate>
          <TextInput
            id="mx-url"
            type="url"
            name="maximo-url"
            labelText={t.urlLabel}
            autoComplete="url"
            inputMode="url"
            placeholder="https://maximo.example.com"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              // 接続先を変えたら、その接続先で前に選んだ環境にする
              if (license !== null) setEnvironment(license.declared(normalizeBaseUrl(e.target.value)));
            }}
            invalid={Boolean(errors.baseUrl)}
            invalidText={errors.baseUrl}
            required
          />
          <Select
            id="mx-via"
            name="via"
            labelText={t.viaLabel}
            value={via}
            onChange={(e) => {
              if (isVia(e.target.value)) setVia(e.target.value);
            }}
            invalid={Boolean(errors.via)}
            invalidText={errors.via}
          >
            <SelectItem value="proxy" text={viaOptionLabel("proxy")} />
            <SelectItem value="direct" text={viaOptionLabel("direct")} />
          </Select>
          <TextInput
            id="mx-name"
            type="text"
            name="username"
            labelText={t.nameLabel}
            autoComplete="username"
            placeholder="MAXADMIN@mas-dev"
            value={connectionName}
            onChange={(e) => setConnectionName(e.target.value)}
            invalid={Boolean(errors.connectionName)}
            invalidText={errors.connectionName}
            required
          />
          {/* 鍵を見せるボタンは付けない（PasswordInput は使わない）。値は React の state に持たない */}
          <TextInput
            id="mx-key"
            type="password"
            name="password"
            labelText={t.keyLabel}
            autoComplete="current-password"
            ref={keyRef}
            invalid={Boolean(errors.apiKey)}
            invalidText={errors.apiKey}
            required
          />
          {canSave && (
            <div className="field">
              <Checkbox
                id="mx-save"
                labelText={s.saveLabel}
                checked={saveOnPc && via === "proxy"}
                disabled={via !== "proxy" || editing !== null}
                onChange={(_e, { checked }) => setSaveOnPc(checked)}
                {...(via !== "proxy" ? { helperText: s.saveDirect } : {})}
              />
            </div>
          )}
          {license !== null && (
            <EnvironmentField environment={environment} onChange={setEnvironment} licensedOrg={licensed ? (licensed.org ?? licensed.licenseId) : null} error={environmentError} />
          )}
          {failure && (
            <Notice kind="error" role="alert">
              {failure}
            </Notice>
          )}
          <div className="actions">
            <Button type="submit" kind="primary" disabled={busy}>
              {editing !== null ? s.update : t.connect}
            </Button>
            {editing !== null && (
              <Button
                kind="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setShowForm(view.kind !== "connected");
                }}
              >
                {s.cancelEdit}
              </Button>
            )}
            {busy && <span className="muted">{t.checking}</span>}
          </div>
        </Form>
      </Layer>
    </section>
  );
}

/**
 * 保存した接続先の一覧。選んでつなぐ・直す（API キーの入れ直し）・消す。
 * 自動の接続に失敗したときは、その理由もここに出す。
 */
function SavedConnections(p: {
  support: SavedSupport;
  connections: readonly SavedConnection[];
  protection: string | null;
  currentId: string | null;
  onEdit: (c: SavedConnection) => void;
  formFailure: string | null;
}) {
  const s = m().saved;
  const env = licenseMessages().environment;
  const [busyId, setBusyId] = useState<string | null>(null);
  const failure = useSyncExternalStore(
    useCallback((l: () => void) => p.support.auto.subscribe(l), [p.support]),
    useCallback(() => p.support.auto.failure(), [p.support]),
  );
  const shownFailure = failure !== null && p.formFailure === null && p.connections.some((c) => c.id === failure.connection.id) ? failure : null;
  return (
    <div className="saved-connections">
      <h3>{s.title}</h3>
      <p className="muted small">
        {s.intro} {p.protection !== null ? s.protection(p.protection) : null}
      </p>
      {shownFailure !== null && (
        <Notice kind="warning" role="alert">
          {s.autoFailed(shownFailure.connection.name)} {connectErrorMessage(shownFailure.error, "proxy")}
          {shownFailure.retrying ? ` ${s.autoRetrying}` : ""}
        </Notice>
      )}
      {p.connections.length === 0 ? (
        <p className="muted small">{s.empty}</p>
      ) : (
        <ul className="plain saved-list">
          {p.connections.map((c) => (
            <li key={c.id} className="saved-item" data-connection={c.id}>
              <div className="saved-text">
                <strong>{c.name}</strong>
                <span className="muted small">
                  {hostOf(c.baseUrl)}
                  {c.environment !== null ? ` · ${c.environment === "production" ? env.production : env.test}` : ""}
                </span>
              </div>
              <div className="saved-actions">
                {p.currentId === c.id ? (
                  <span className="saved-current">{s.inUse}</span>
                ) : (
                  <Button
                    kind="primary"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => {
                      setBusyId(c.id);
                      p.support.auto
                        .connect(c)
                        .catch(() => undefined)
                        .finally(() => setBusyId(null));
                    }}
                  >
                    {busyId === c.id ? s.connecting : s.use}
                  </Button>
                )}
                <Button kind="ghost" size="sm" disabled={busyId !== null} onClick={() => p.onEdit(c)}>
                  {s.editKey}
                </Button>
                <Button
                  kind="danger--ghost"
                  size="sm"
                  disabled={busyId !== null}
                  onClick={() => {
                    if (!window.confirm(s.removeConfirm(c.name))) return;
                    if (p.currentId === c.id) p.support.auto.disconnect();
                    void p.support.client.remove(c.id);
                  }}
                >
                  {s.remove}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 接続先の環境（本番／テスト）の選択。ライセンスキーに書かれた接続先はいつも本番なので、選ばせずにそう書く */
function EnvironmentField(p: { environment: Environment | null; onChange: (e: Environment) => void; licensedOrg: string | null; error: string | null }) {
  const t = licenseMessages().environment;
  if (p.licensedOrg !== null) {
    return (
      <div className="field env-field">
        <span className="cds--label">{t.label}</span>
        <p>{t.licensedBy(p.licensedOrg)}</p>
        <p className="muted small">{t.licensedLocked}</p>
      </div>
    );
  }
  return (
    <div className="field env-field">
      <RadioButtonGroup
        legendText={t.label}
        name="mx-environment"
        orientation="vertical"
        valueSelected={p.environment ?? ""}
        onChange={(value) => {
          if (value === "production" || value === "test") p.onChange(value);
        }}
        invalid={p.error !== null}
        invalidText={p.error ?? undefined}
      >
        <RadioButton id="mx-env-test" labelText={t.testOption} value="test" />
        <RadioButton id="mx-env-production" labelText={t.productionOption} value="production" />
      </RadioButtonGroup>
      <p className="muted small">{t.help}</p>
    </div>
  );
}

/** 接続先ごとの、過去の作業のステータス（apply_rule の phase で past を省いたとき）。選ぶとすぐ覚える */
function PastStatusField(p: { baseUrl: string; storage: StorageLike | null }) {
  const t = m().maximo.pastStatus;
  const [value, setValue] = useState<PastStatus>(() => pastStatusOf(p.storage, p.baseUrl));
  useEffect(() => setValue(pastStatusOf(p.storage, p.baseUrl)), [p.storage, p.baseUrl]);
  return (
    <div className="field past-status-field">
      <RadioButtonGroup
        legendText={t.label}
        name="mx-past-status"
        orientation="vertical"
        valueSelected={value}
        onChange={(v) => {
          if (v !== "COMP" && v !== "CLOSE") return;
          setValue(v);
          setPastStatus(p.storage, p.baseUrl, v);
        }}
      >
        <RadioButton id="mx-past-comp" labelText={t.comp} value="COMP" />
        <RadioButton id="mx-past-close" labelText={t.close} value="CLOSE" />
      </RadioButtonGroup>
      <p className="muted small">{t.help}</p>
    </div>
  );
}

function ConnectedInfo({ info, license, onReconnect, onDisconnect }: { info: MaximoConnectionInfo; license: LicenseClient | null; onReconnect: () => void; onDisconnect: () => void }) {
  const t = licenseMessages().environment;
  const c = m().maximo;
  const licensedEntry = license?.licenseFor(info.baseUrl) ?? null;
  const environment = license?.environmentOf(info.baseUrl) ?? null;
  return (
    <div className="connected">
      <Notice kind="success">{c.connected}</Notice>
      <dl className="kv">
        <dt>{c.nameLabel}</dt>
        <dd>{info.connectionName}</dd>
        <dt>{c.maximo}</dt>
        <dd>{c.hostVia(hostOf(info.baseUrl), info.via !== "proxy")}</dd>
        <dt>{c.user}</dt>
        <dd>{info.userName ?? c.unknownUser}</dd>
        {info.savedId !== undefined && (
          <>
            <dt>{m().saved.title}</dt>
            <dd>{m().saved.savedBadge}</dd>
          </>
        )}
        {license !== null && (
          <>
            <dt>{t.label}</dt>
            <dd>{licensedEntry !== null ? t.licensedBy(licensedEntry.org ?? licensedEntry.licenseId) : environment === "production" ? t.production : environment === "test" ? t.test : "—"}</dd>
          </>
        )}
      </dl>
      <div className="actions">
        <Button kind="primary" href={APP_PATH} onClick={spaClick(APP_PATH)}>
          {c.backToApp}
        </Button>
        <Button kind="secondary" onClick={onReconnect}>
          {c.reconnect}
        </Button>
        <Button kind="secondary" onClick={onDisconnect}>
          {c.disconnect}
        </Button>
      </div>
    </div>
  );
}

function CopyButton({ text, clipboard }: { text: string; clipboard: ClipboardLike | null }) {
  const [copied, setCopied] = useState(false);
  if (!clipboard) return null;
  return (
    <Button
      kind="tertiary"
      size="sm"
      onClick={() => {
        clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? m().llm.copied : m().llm.copy}
    </Button>
  );
}

/** AI アシスタントの接続。橋渡しは stdio の MCP なので URL もトークンも無く、現状を示すだけにする */
function LlmSection({ clipboard }: { clipboard: ClipboardLike | null }) {
  const status = localClientStatus();
  const t = m().llm;
  return (
    <section className="card">
      <h2>{t.title}</h2>
      <Notice kind="info">{status.summary}</Notice>
      {status.notes.map((n, i) => (
        <p key={i} className="muted">
          {n}
        </p>
      ))}
      <div className="field">
        <span className="cds--label">{t.check}</span>
        <div className="copy-row">
          <code className="mono">{status.checkCommand}</code>
          <CopyButton text={status.checkCommand} clipboard={clipboard} />
        </div>
      </div>
    </section>
  );
}

/** 作業画面の言語。選んだ言語はこのブラウザに覚え、画面を作り直して切り替える（src/app/ui/locale.ts） */
function LanguageSection({ storage }: { storage: StorageLike | null }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const t = m().language;
  return (
    <section className="card">
      <h2>{t.title}</h2>
      <div className="field">
        <RadioButtonGroup
          legendText={t.label}
          name="ui-language"
          orientation="vertical"
          valueSelected={locale}
          onChange={(value) => {
            if (isLocale(value)) chooseLocale(value, storage);
          }}
        >
          {LOCALES.map((l) => (
            <RadioButton key={l} id={`ui-language-${l}`} labelText={LANGUAGE_NAMES[l]} value={l} lang={l} />
          ))}
        </RadioButtonGroup>
        <p className="muted small">{t.help}</p>
      </div>
    </section>
  );
}
