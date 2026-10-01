// API 設定画面 /settings（トップレベルのページ。iframe に入れない）。
// Maximo への接続は、パスワードマネージャーが保存を検知できる標準のログインフォームの形にする。
// API キーの入力欄は React の state に持たない（非制御の入力欄から読んで Web Worker に渡し、すぐ空にする）。

import { Button, Form, Layer, RadioButton, RadioButtonGroup, Select, SelectItem, TextInput } from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { LOCALES, getLocale, isLocale, subscribeLocale } from "../../shared/i18n";
import type { ConnectInput, VaultView } from "../keyvault/client";
import type { Environment, LicenseClient } from "../license/client";
import { licenseMessages } from "../license/messages";
import type { MaximoVia } from "../maximo/client";
import { hostOf } from "../pages/status";
import type { MaximoConnectionInfo } from "../runtime/contracts";
import { spaClick } from "../ui/Link";
import { chooseLocale } from "../ui/locale";
import { Notice } from "../ui/Notice";
import { APP_PATH } from "../ui/routes";
import { LicenseSection } from "./LicenseSection";
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

  const t = m().page;
  return (
    <main className="page settings">
      <header className="page-head">
        <h1>{t.title}</h1>
        <Button kind="tertiary" size="md" href={APP_PATH} onClick={spaClick(APP_PATH)}>
          {t.backToApp}
        </Button>
      </header>
      <MaximoSection
        vault={vault}
        view={view}
        storage={storage}
        passwordCredential={passwordCredential}
        replaceUrl={replaceUrl}
        license={props.license ?? null}
      />
      {props.license && <LicenseSection license={props.license} />}
      <LlmSection clipboard={clipboard} />
      <SkillsSection load={loadSkills} />
      <LanguageSection storage={storage} />
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
          <SkillItems items={defaults} empty={t.defaultsEmpty} />
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
}

function MaximoSection({ vault, view, storage, passwordCredential, replaceUrl, license }: MaximoSectionProps) {
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
  const keyRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ロック・切断されたらフォームに戻す
  useEffect(() => {
    if (view.kind !== "connected") setShowForm(true);
  }, [view.kind]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const keyInput = keyRef.current;
    if (!keyInput) return;
    const name = connectionName.trim();
    const url = normalizeBaseUrl(baseUrl);
    const found = validateSettingsForm({ baseUrl: url, via, connectionName: name, apiKey: keyInput.value });
    setErrors(found);
    setFailure(null);
    // 環境は必ず選ぶ（ライセンスキーに書かれた接続先はいつも本番なので選ばなくてよい）
    const needsEnvironment = license !== null && licensed === null && environment === null;
    setEnvironmentError(needsEnvironment ? licenseMessages().environment.required : null);
    if (Object.keys(found).length > 0 || needsEnvironment) return;

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
  if (!showForm && view.kind === "connected") {
    return (
      <section className="card">
        <h2>{t.title}</h2>
        <ConnectedInfo info={view.info} license={license} onReconnect={() => setShowForm(true)} onDisconnect={() => vault.disconnect()} />
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{t.title}</h2>
      {view.kind === "locked" && <Notice kind="warning">{view.reason === "idle" ? t.lockedIdle : t.lockedManual}</Notice>}
      <p className="muted">{t.keyNote}</p>
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
              {t.connect}
            </Button>
            {busy && <span className="muted">{t.checking}</span>}
          </div>
        </Form>
      </Layer>
    </section>
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

/** LLM クライアントの接続。橋渡しは stdio の MCP なので URL もトークンも無く、現状を示すだけにする */
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
