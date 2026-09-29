// オブジェクト構造の画面 /structures。
// 作業画面は Maximo に接続すると、すべてのオブジェクト構造の定義を機械的に読み込んで保存する（src/app/catalog/autosync.ts）。
// この画面では、読み込みの進み具合、保存した構造の検索（LLM の find_object_structures と同じ決め方）、
// キー列・子オブジェクト・属性、その構造を使って読み込んだシートを見る。
// LLM は利用者の業務の言葉からここの構造を見繕ってシートを読み込み、Maximo への反映もその構造に対して行う。

import {
  Accordion,
  AccordionItem,
  Button,
  Layer,
  ProgressBar,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
} from "@carbon/react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { CHILD_ID_NOTE, resolveKeyColumns } from "../tools/loadSheet";
import { foldText, normalizeScope, type CatalogSnapshot, type ObjectStructureCatalog, type StoredApiList, type StoredObjectStructure } from "../catalog/catalog";
import { searchStructures, searchTerms } from "../catalog/search";
import type { VaultView } from "../keyvault/client";
import type { MaximoConnection } from "../runtime/contracts";
import { loadSavedSettings, type StorageLike } from "../settings/logic";
import type { Workspace } from "../store";
import { Link, spaClick } from "../ui/Link";
import { Notice } from "../ui/Notice";
import { APP_PATH, SETTINGS_PATH } from "../ui/routes";
import type { ToastStore } from "../ui/toast";
import { childSummaries, filterColumns, formatDateTime, groupByUseWith, loadErrorMessage, parentColumnCount, parseScopeKey, scopeKey, sheetsByStructure, type ColumnScope } from "./logic";

export interface StructuresVault {
  getView(): VaultView;
  subscribe(listener: () => void): () => void;
  current(): MaximoConnection | null;
}

export interface StructuresPageProps {
  catalog: ObjectStructureCatalog;
  vault: StructuresVault;
  toasts: ToastStore;
  /** 作業画面を開いていれば、その作業（構造を使って読み込んだシートを出す） */
  workspace?: Workspace | null;
  /** 未接続のときに接続先を読む（省略時は localStorage） */
  storage?: StorageLike | null;
  confirm?: (message: string) => boolean;
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const TYPE_LABEL: Record<string, string> = {
  string: "文字",
  integer: "整数",
  number: "数値",
  boolean: "真偽",
  date: "日付",
  datetime: "日時",
  unknown: "不明",
};

/** 作業のシートが増減・置き換わったら描き直す */
function useWorkspaceVersion(workspace: Workspace | null | undefined): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!workspace) return undefined;
    return workspace.subscribe(() => setVersion((v) => v + 1));
  }, [workspace]);
  return version;
}

export function StructuresPage(props: StructuresPageProps) {
  const { catalog, vault, toasts, workspace } = props;
  const confirmFn = props.confirm ?? ((m: string) => window.confirm(m));
  const storage = props.storage === undefined ? browserStorage() : props.storage;

  const view = useSyncExternalStore(
    useCallback((l: () => void) => vault.subscribe(l), [vault]),
    useCallback(() => vault.getView(), [vault]),
  );
  const connected = view.kind === "connected";
  // 接続中（ロック中を含む）はその接続先、未接続なら設定画面に保存した接続先
  const baseUrl = view.kind === "disconnected" ? loadSavedSettings(storage).baseUrl : view.info.baseUrl;

  const snapshot = useSyncExternalStore(
    useCallback((l: () => void) => catalog.subscribe(l), [catalog]),
    useCallback(() => (baseUrl ? catalog.snapshot(baseUrl) : null), [catalog, baseUrl]),
  );

  const workspaceVersion = useWorkspaceVersion(workspace);
  const usage = useMemo(() => (workspace && baseUrl ? sheetsByStructure(workspace, baseUrl) : new Map<string, string[]>()), [workspace, baseUrl, workspaceVersion]);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const entries = snapshot?.entries ?? [];
  const found = useMemo(() => (query.trim() === "" ? null : searchStructures(entries, query, { limit: 50, columnsPerStructure: 3 })), [entries, query]);
  const listed: StoredObjectStructure[] = useMemo(() => {
    if (found === null) return [...entries];
    const byOs = new Map(entries.map((e) => [e.os, e]));
    return found.hits.map((h) => byOs.get(h.os)).filter((e): e is StoredObjectStructure => e !== undefined);
  }, [entries, found]);
  const current = listed.find((e) => e.os === selected) ?? entries.find((e) => e.os === selected) ?? listed[0] ?? null;

  const refreshAll = useCallback(async () => {
    const conn = vault.current();
    if (conn === null) {
      toasts.show("Maximo に接続していないため取り直せません。設定で接続してください。", "error");
      return;
    }
    const inUse = Array.from(usage.values()).flat();
    const warn = inUse.length > 0 ? `\n読み込み済みのシート（${inUse.join("、")}）は、読み込んだときの定義で反映します。取り直した定義で反映に使う列が変わっていたら、そのシートは読み込み直すまで反映できません。` : "";
    if (!confirmFn(`Maximo から、すべてのオブジェクト構造の定義を取り直しますか？${warn}`)) return;
    const scope = normalizeScope(conn.info.baseUrl);
    const result = await catalog.syncAll(conn.client, conn.info.baseUrl, {
      refresh: true,
      shouldContinue: () => {
        const c = vault.current();
        return c !== null && normalizeScope(c.info.baseUrl) === scope;
      },
    });
    if (result.state === "done") toasts.show(`オブジェクト構造 ${result.total} 件を取り直しました${result.failed.length > 0 ? `（読めなかったもの ${result.failed.length} 件）` : ""}。`);
    else if (result.state === "failed") toasts.show(result.error ?? "取り直せませんでした。", "error");
  }, [catalog, vault, toasts, usage, confirmFn]);

  const refreshOne = useCallback(
    async (entry: StoredObjectStructure) => {
      const conn = vault.current();
      if (conn === null) {
        toasts.show("Maximo に接続していないため再読み込みできません。設定で接続してください。", "error");
        return;
      }
      const sheets = usage.get(entry.os) ?? [];
      if (sheets.length > 0 && !confirmFn(`${entry.os} を使って読み込んだシート（${sheets.join("、")}）があります。取り直した定義で反映に使う列が変わっていたら、そのシートは読み込み直すまで反映できません。再読み込みしますか？`)) {
        return;
      }
      try {
        const r = await catalog.ensure(conn.client, conn.info.baseUrl, entry.os, { refresh: true });
        toasts.show(`${r.entry.os} を読み直しました（${r.entry.info.columns.length} 列）。`);
      } catch (e) {
        toasts.show(loadErrorMessage(entry.os, e), "error");
      }
    },
    [catalog, vault, toasts, usage, confirmFn],
  );

  const hitFor = (os: string) => found?.hits.find((h) => h.os === os) ?? null;
  // 探した言葉で属性が当たった構造を開くときは、その言葉で属性を絞っておく
  const detailQuery =
    current !== null && (hitFor(current.os)?.columns.length ?? 0) > 0
      ? (searchTerms(query).find((t) => current.info.columns.some((c) => foldText(c.title ?? "").includes(t) || foldText(c.name).includes(t))) ?? "")
      : "";

  return (
    <main className="page wide structures">
      <header className="page-head">
        <h1>オブジェクト構造</h1>
        <div className="actions">
          <Button kind="tertiary" size="md" href={SETTINGS_PATH} onClick={spaClick(SETTINGS_PATH)}>
            設定
          </Button>
          <Button kind="tertiary" size="md" href={APP_PATH} onClick={spaClick(APP_PATH)}>
            作業画面に戻る
          </Button>
        </div>
      </header>

      {!baseUrl || snapshot === null ? (
        <section className="card">
          {/* 知らせの中にはリンクを置けない（Carbon が拒む）ので、設定へのリンクは知らせの下に置く */}
          <Notice kind="warning">Maximo の接続先がまだありません。</Notice>
          <p>
            <Link to={SETTINGS_PATH}>設定</Link>で接続すると、すべてのオブジェクト構造を自動で読み込みます。
          </p>
        </section>
      ) : (
        <>
          <SyncSection baseUrl={baseUrl} connected={connected} locked={view.kind === "locked"} snapshot={snapshot} onRefreshAll={() => void refreshAll()} />
          <div className="structures-body">
            <section className="card os-list" aria-label="保存したオブジェクト構造">
              <Layer>
                <TextInput
                  id="os-search"
                  labelText="オブジェクト構造を探す"
                  hideLabel
                  aria-label="オブジェクト構造を探す"
                  placeholder="業務の言葉や名前で探す（例 許可申請、タグ番号、MXAPIWO）"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Layer>
              <p className="muted small count" role="status">
                {found === null ? `保存済み ${entries.length} 件` : `当たった構造 ${found.totalHits} 件${found.partial ? "（一部の言葉だけに当たる）" : ""}`}
              </p>
              {snapshot.ready && entries.length === 0 && <p className="muted">まだありません。</p>}
              <ul className="plain">
                {listed.map((e) => {
                  const hit = hitFor(e.os);
                  const sheets = usage.get(e.os) ?? [];
                  return (
                    <li key={e.os}>
                      <button
                        type="button"
                        className="os-item"
                        aria-current={current?.os === e.os}
                        onClick={() => setSelected(e.os)}
                        title={sheets.length > 0 ? `使っているシート: ${sheets.join("、")}` : undefined}
                      >
                        <span className="os-item-head">
                          <span className="mono">{e.os}</span>
                          {sheets.length > 0 && (
                            <Tag as="span" type="blue" size="sm" className="badge">
                              シート {sheets.length}
                            </Tag>
                          )}
                        </span>
                        <span className="muted small">
                          {hit && hit.columns.length > 0 ? hit.columns.map((c) => c.title ?? c.name).join("・") : `${parentColumnCount(e)} 列${Object.keys(e.info.childIdAttrs).length > 0 ? `・子 ${Object.keys(e.info.childIdAttrs).length}` : ""}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
            {current === null ? (
              <section className="card">
                <p className="muted">読み込むと、ここにキー列・子オブジェクト・属性が出ます。</p>
              </section>
            ) : (
              <StructureDetail
                // 検索語が変わったら、当たった属性で絞り直すために作り直す
                key={`${current.os}-${current.loadedAt}-${detailQuery}`}
                entry={current}
                initialQuery={detailQuery}
                sheets={usage.get(current.os) ?? []}
                connected={connected}
                refreshing={snapshot.loading.includes(current.os)}
                onRefresh={() => void refreshOne(current)}
              />
            )}
          </div>
        </>
      )}
    </main>
  );
}

interface SyncSectionProps {
  baseUrl: string;
  connected: boolean;
  locked: boolean;
  snapshot: CatalogSnapshot;
  onRefreshAll: () => void;
}

function SyncSection({ baseUrl, connected, locked, snapshot, onRefreshAll }: SyncSectionProps) {
  const sync = snapshot.sync;
  let status: ReactNode;
  if (sync.state === "running") {
    const label = `Maximo から${sync.refresh ? "取り直しています" : "読み込んでいます"}（${sync.done} / ${sync.total}）`;
    status = <ProgressBar className="sync-progress" label={label} max={Math.max(1, sync.total)} value={sync.done} />;
  } else if (sync.state === "failed") {
    status = <Notice kind="error">{sync.error ?? "オブジェクト構造の一覧を読めませんでした。"}</Notice>;
  } else if (sync.state === "stopped") {
    status = (
      <Notice kind="warning">
        接続が切れたため、読み込みを途中で止めました（{sync.done} / {sync.total}）。接続すると続きを読み込みます。
      </Notice>
    );
  } else if (sync.state === "done") {
    status = (
      <p className="muted" role="status">
        保存済み {snapshot.entries.length} 件{sync.finishedAt !== undefined ? `（${formatDateTime(sync.finishedAt)} に Maximo と照合）` : ""}
      </p>
    );
  } else {
    status = <p className="muted">{connected ? "読み込みを始めます…" : `保存済み ${snapshot.entries.length} 件。Maximo に接続すると、足りない定義を自動で読み込みます。`}</p>;
  }
  return (
    <section className="card">
      <div className="detail-head">
        <h2>Maximo から読み込んだ定義</h2>
        <Button kind="tertiary" size="sm" onClick={onRefreshAll} disabled={!connected || sync.state === "running"}>
          すべて取り直す
        </Button>
      </div>
      <p className="muted">
        接続先: <span className="mono">{baseUrl}</span>
      </p>
      {status}
      {snapshot.apiList !== null && <ListSummary list={snapshot.apiList} />}
      {!connected && (
        <>
          <Notice kind="warning">
            {locked ? "API キーがロックされているため" : "Maximo に接続していないため"}、読み込みと取り直しはできません。保存済みの定義は見られます。
          </Notice>
          <p className="small">
            <Link to={SETTINGS_PATH}>設定</Link>
          </p>
        </>
      )}
      {sync.failed.length > 0 && (
        <Accordion size="sm" align="start">
          <AccordionItem className="sync-failed" title={`読み込めなかった構造（${sync.failed.length} 件）`}>
            <ul className="plain small">
              {sync.failed.map((f) => (
                <li key={f.os}>
                  <span className="mono">{f.os}</span> <span className="muted">{f.message}</span>
                </li>
              ))}
            </ul>
          </AccordionItem>
        </Accordion>
      )}
      {snapshot.storageError ? (
        <Notice kind="warning">{snapshot.storageError}</Notice>
      ) : (
        <p className="muted small">
          定義はこのブラウザに保存され、作業を終了しても残ります（API キーと行データは保存しません）。LLM は利用者の業務の言葉からここの構造を見繕ってシートを読み込み、Maximo
          への反映もその構造に対して行います。
        </p>
      )}
    </section>
  );
}

/** 一覧の内訳: Maximo に定義された数、API で使える数（apimeta に載らず足した数）、API で使えないため読み込まない構造 */
function ListSummary({ list }: { list: StoredApiList }) {
  const notApi = list.notApi ?? [];
  const groups = groupByUseWith(notApi);
  const added = list.addedFromDefinitions ?? 0;
  return (
    <>
      <p className="muted small list-summary">
        {typeof list.definedCount === "number" ? `Maximo に定義されたオブジェクト構造 ${list.definedCount} 件のうち、API で使える ${list.items.length} 件を読み込みます` : `API で使えるオブジェクト構造 ${list.items.length} 件を読み込みます`}
        {added > 0 ? `（apimeta に載らない ${added} 件を含む）` : ""}。
      </p>
      {notApi.length > 0 && (
        <Accordion size="sm" align="start">
          <AccordionItem
            className="not-api"
            title={`API で使えないため読み込まない構造（${notApi.length} 件: ${groups.map((g) => `${g.usewith} ${g.names.length} 件`).join("、")}）`}
          >
            <ul className="plain small">
              {groups.map((g) => (
                <li key={g.usewith}>
                  <span className="muted">{g.usewith}</span> <span className="mono">{g.names.join(", ")}</span>
                </li>
              ))}
            </ul>
          </AccordionItem>
        </Accordion>
      )}
      {list.definedError !== undefined && (
        <Notice kind="warning">
          Maximo の定義の一覧（MXAPIINTOBJECT）を読めなかったため、apimeta に載る構造だけを読み込みました。apimeta には顧客が作った構造が載らないことがあります（{list.definedError}）。
        </Notice>
      )}
    </>
  );
}

interface StructureDetailProps {
  entry: StoredObjectStructure;
  initialQuery: string;
  sheets: readonly string[];
  connected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

function StructureDetail({ entry, initialQuery, sheets, connected, refreshing, onRefresh }: StructureDetailProps) {
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState<ColumnScope>({ kind: "all" });
  const keys = useMemo(() => resolveKeyColumns(entry.info), [entry]);
  const children = useMemo(() => childSummaries(entry), [entry]);
  const columns = useMemo(() => filterColumns(entry.info.columns, scope, query), [entry, scope, query]);

  // 子オブジェクトの範囲を選んでいる間に、読み直しでその子が無くなったら全体に戻す
  useEffect(() => {
    if (scope.kind === "child" && !children.some((c) => c.name === scope.name)) setScope({ kind: "all" });
  }, [children, scope]);

  const sourceLabel = keys.source === "schema" ? "スキーマの主キー" : keys.source === "inferred" ? "推定" : "キー列なし（href で識別）";
  return (
    <section className="card structure-detail" aria-label={`${entry.os} の定義`}>
      <div className="detail-head">
        <h2 className="mono">{entry.os}</h2>
        <div className="actions">
          <span className="muted small">{formatDateTime(entry.loadedAt)} に読み込み</span>
          <Button kind="ghost" size="sm" onClick={onRefresh} disabled={!connected || refreshing}>
            {refreshing ? "読み込み中…" : "再読み込み"}
          </Button>
        </div>
      </div>
      <dl className="kv">
        <dt>キー列</dt>
        <dd>
          <span className="mono">{keys.keyColumns.join(", ") || "なし"}</span> <span className="muted small">（{sourceLabel}）</span>
        </dd>
        <dt>属性</dt>
        <dd>
          親 {parentColumnCount(entry)} 列・合計 {entry.info.columns.length} 列
        </dd>
        <dt>使っているシート</dt>
        <dd className="used-sheets">{sheets.length > 0 ? sheets.join("、") : <span className="muted">なし</span>}</dd>
      </dl>
      {keys.note !== undefined && <p className="muted small">{keys.note}</p>}

      <h3>子オブジェクト</h3>
      {children.length === 0 ? (
        <p className="muted">子オブジェクトはありません。</p>
      ) : (
        <>
          <div className="table-wrap">
            <Table size="sm" className="child-table">
              <TableHead>
                <TableRow>
                  <TableHeader>子オブジェクト</TableHeader>
                  <TableHeader>子を特定する属性</TableHeader>
                  <TableHeader>列数</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {children.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="mono">
                      <button type="button" className="link" onClick={() => setScope({ kind: "child", name: c.name })}>
                        {c.name}
                      </button>
                    </TableCell>
                    <TableCell className="mono">{c.idAttr ?? <span className="muted">不明（追加だけできる）</span>}</TableCell>
                    <TableCell>{c.columnCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="muted small">{CHILD_ID_NOTE}</p>
        </>
      )}

      <h3>属性</h3>
      <Layer className="filter-row">
        <TextInput
          id={`attr-filter-${entry.os}`}
          size="sm"
          labelText="属性の絞り込み"
          hideLabel
          aria-label="属性の絞り込み"
          placeholder="名前や日本語ラベルの一部（例 申請、TAGNO）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        <Select
          id={`attr-scope-${entry.os}`}
          size="sm"
          labelText="範囲"
          hideLabel
          aria-label="範囲"
          value={scopeKey(scope)}
          onChange={(e) => setScope(parseScopeKey(e.target.value))}
        >
          <SelectItem value="all" text="すべて" />
          <SelectItem value="parent" text="親だけ" />
          {children.map((c) => (
            <SelectItem key={c.name} value={`child:${c.name}`} text={`子 ${c.name}`} />
          ))}
        </Select>
        <span className="muted small count" role="status">
          {columns.length} / {entry.info.columns.length} 列
        </span>
      </Layer>
      <div className="attr-scroll">
        <Table size="sm" className="attr-table">
          <TableHead>
            <TableRow>
              <TableHeader>属性</TableHeader>
              <TableHeader>ラベル</TableHeader>
              <TableHeader>型</TableHeader>
              <TableHeader>桁</TableHeader>
              <TableHeader>必須</TableHeader>
              <TableHeader>読み取り専用</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {columns.map((c) => (
              <TableRow key={c.name}>
                <TableCell className="mono">{c.name}</TableCell>
                <TableCell>{c.title ?? ""}</TableCell>
                <TableCell>{TYPE_LABEL[c.type] ?? c.type}</TableCell>
                <TableCell>{c.maxLength ?? ""}</TableCell>
                <TableCell>{c.required ? "必須" : ""}</TableCell>
                <TableCell>{c.readOnly ? "読み取り専用" : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
