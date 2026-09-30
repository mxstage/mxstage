// API 設定画面 /settings（トップレベルのページ。iframe に入れない）。
// Maximo への接続は、パスワードマネージャーが保存を検知できる標準のログインフォームの形にする。
// API キーの入力欄は React の state に持たない（非制御の入力欄から読んで Web Worker に渡し、すぐ空にする）。

import { Button, Form, Layer, RadioButton, RadioButtonGroup, Select, SelectItem, TextInput } from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { ConnectInput, VaultView } from "../keyvault/client";
import type { Environment, LicenseClient } from "../license/client";
import { licenseMessages } from "../license/messages";
import type { MaximoVia } from "../maximo/client";
import { hostOf } from "../pages/status";
import type { MaximoConnectionInfo } from "../runtime/contracts";
import { spaClick } from "../ui/Link";
import { Notice } from "../ui/Notice";
import { APP_PATH } from "../ui/routes";
import { LicenseSection } from "./LicenseSection";
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
  return e instanceof Error && e.message ? e.message : "処理に失敗しました。";
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

  return (
    <main className="page settings">
      <header className="page-head">
        <h1>設定</h1>
        <Button kind="tertiary" size="md" href={APP_PATH} onClick={spaClick(APP_PATH)}>
          作業画面に戻る
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
  return (
    <section className="card skills">
      <h2>Skill（作業手順書）</h2>
      <p className="muted">LLM に MX Stage の作業手順と禁止事項を教えるファイルです。Claude Code は新しいセッションから読みます。</p>
      {state.kind === "loading" && <p className="muted">一覧を読んでいます…</p>}
      {state.kind === "error" && <Notice kind="warning">{state.message}</Notice>}
      {state.kind === "ok" && (
        <>
          <h3>アプリ既定</h3>
          <p className="muted small">MX Stage と一緒に入り、MX Stage を更新すると置き換わります。書き換えないでください。</p>
          <SkillItems items={defaults} empty="ありません。" />
          <h3>利用者の Skill</h3>
          <p className="muted small">
            業務や客先ごとの手順です。
            {state.list.userSkillsDir !== null ? (
              <>
                {" "}
                <code className="mono">{state.list.userSkillsDir}</code> の下に <code className="mono">&lt;名前&gt;/SKILL.md</code> で置きます。
              </>
            ) : null}
            MX Stage を更新しても消えず、公開もされません。置いたあと導入をやり直すと Claude Code に入ります。
          </p>
          <SkillItems items={users} empty="まだありません。" />
          {problems.length > 0 && (
            <ul className="plain skill-problems">
              {problems.map((p, i) => (
                <li key={i}>
                  <Notice kind={p.level === "error" ? "error" : "warning"}>
                    {p.name !== "" && <code className="mono">{p.name}</code>} {p.level === "error" ? "読み込めません: " : "注意: "}
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
          {s.version && <span className="muted small"> 版 {s.version}</span>}
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

  if (!showForm && view.kind === "connected") {
    return (
      <section className="card">
        <h2>Maximo への接続</h2>
        <ConnectedInfo info={view.info} license={license} onReconnect={() => setShowForm(true)} onDisconnect={() => vault.disconnect()} />
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Maximo への接続</h2>
      {view.kind === "locked" && (
        <Notice kind="warning">
          {view.reason === "idle" ? "無操作が 30 分続いたため、API キーをメモリから消しました（ロック中）。もう一度接続してください。" : "接続を切りました。"}
        </Notice>
      )}
      <p className="muted">
        API キーはこのタブのメモリ（専用の Web Worker）にだけ置き、サーバやブラウザのストレージには保存しません。記憶はブラウザのパスワードマネージャーに任せてください。
      </p>
      {/* カードは layer-01 の面。入力欄は一段上の面の色で描く */}
      <Layer>
        <Form className="connect-form" onSubmit={onSubmit} noValidate>
          <TextInput
            id="mx-url"
            type="url"
            name="maximo-url"
            labelText="Maximo URL"
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
            labelText="接続方式"
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
            labelText="接続名"
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
            labelText="API キー"
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
              接続
            </Button>
            {busy && <span className="muted">確認しています…</span>}
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
  const licensedEntry = license?.licenseFor(info.baseUrl) ?? null;
  const environment = license?.environmentOf(info.baseUrl) ?? null;
  return (
    <div className="connected">
      <Notice kind="success">接続しました。</Notice>
      <dl className="kv">
        <dt>接続名</dt>
        <dd>{info.connectionName}</dd>
        <dt>Maximo</dt>
        <dd>
          {hostOf(info.baseUrl)}（{info.via === "proxy" ? "proxy" : "直結"}）
        </dd>
        <dt>Maximo の利用者</dt>
        <dd>{info.userName ?? "（不明）"}</dd>
        {license !== null && (
          <>
            <dt>{t.label}</dt>
            <dd>{licensedEntry !== null ? t.licensedBy(licensedEntry.org ?? licensedEntry.licenseId) : environment === "production" ? t.production : environment === "test" ? t.test : "—"}</dd>
          </>
        )}
      </dl>
      <div className="actions">
        <Button kind="primary" href={APP_PATH} onClick={spaClick(APP_PATH)}>
          作業画面に戻る
        </Button>
        <Button kind="secondary" onClick={onReconnect}>
          別の接続にする
        </Button>
        <Button kind="secondary" onClick={onDisconnect}>
          接続を切る
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
      {copied ? "コピーしました" : "コピー"}
    </Button>
  );
}

/** LLM クライアントの接続。橋渡しは stdio の MCP なので URL もトークンも無く、現状を示すだけにする */
function LlmSection({ clipboard }: { clipboard: ClipboardLike | null }) {
  const status = localClientStatus();
  return (
    <section className="card">
      <h2>LLM クライアントの接続</h2>
      <Notice kind="info">{status.summary}</Notice>
      {status.notes.map((n, i) => (
        <p key={i} className="muted">
          {n}
        </p>
      ))}
      <div className="field">
        <span className="cds--label">登録を確かめる</span>
        <div className="copy-row">
          <code className="mono">{status.checkCommand}</code>
          <CopyButton text={status.checkCommand} clipboard={clipboard} />
        </div>
      </div>
    </section>
  );
}
