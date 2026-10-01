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
import { structuresMessages } from "./messages";
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

/** 列の型の名前（今の言語。知らない型はそのまま） */
function typeLabel(type: string): string {
  const labels: Readonly<Record<string, string>> = structuresMessages().type;
  return labels[type] ?? type;
}

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
  const t = structuresMessages();

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
      toasts.show(structuresMessages().notConnectedRefreshAll, "error");
      return;
    }
    const inUse = Array.from(usage.values()).flat();
    const msg = structuresMessages();
    const warn = inUse.length > 0 ? msg.refreshAllWarn(inUse.join(msg.listSeparator)) : "";
    if (!confirmFn(msg.confirmRefreshAll(warn))) return;
    const scope = normalizeScope(conn.info.baseUrl);
    const result = await catalog.syncAll(conn.client, conn.info.baseUrl, {
      refresh: true,
      shouldContinue: () => {
        const c = vault.current();
        return c !== null && normalizeScope(c.info.baseUrl) === scope;
      },
    });
    if (result.state === "done") toasts.show(msg.refreshedAll(result.total, result.failed.length));
    else if (result.state === "failed") toasts.show(result.error ?? msg.refreshFailed, "error");
  }, [catalog, vault, toasts, usage, confirmFn]);

  const refreshOne = useCallback(
    async (entry: StoredObjectStructure) => {
      const conn = vault.current();
      const msg = structuresMessages();
      if (conn === null) {
        toasts.show(msg.notConnectedRefreshOne, "error");
        return;
      }
      const sheets = usage.get(entry.os) ?? [];
      if (sheets.length > 0 && !confirmFn(msg.confirmRefreshOne(entry.os, sheets.join(msg.listSeparator)))) {
        return;
      }
      try {
        const r = await catalog.ensure(conn.client, conn.info.baseUrl, entry.os, { refresh: true });
        toasts.show(msg.refreshedOne(r.entry.os, r.entry.info.columns.length));
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
        <h1>{t.title}</h1>
        <div className="actions">
          <Button kind="tertiary" size="md" href={SETTINGS_PATH} onClick={spaClick(SETTINGS_PATH)}>
            {t.settings}
          </Button>
          <Button kind="tertiary" size="md" href={APP_PATH} onClick={spaClick(APP_PATH)}>
            {t.back}
          </Button>
        </div>
      </header>

      {!baseUrl || snapshot === null ? (
        <section className="card">
          {/* 知らせの中にはリンクを置けない（Carbon が拒む）ので、設定へのリンクは知らせの下に置く */}
          <Notice kind="warning">{t.noConnection}</Notice>
          <p>
            {t.connectBefore}
            <Link to={SETTINGS_PATH}>{t.connectLink}</Link>
            {t.connectAfter}
          </p>
        </section>
      ) : (
        <>
          <SyncSection baseUrl={baseUrl} connected={connected} locked={view.kind === "locked"} snapshot={snapshot} onRefreshAll={() => void refreshAll()} />
          <div className="structures-body">
            <section className="card os-list" aria-label={t.listLabel}>
              <Layer>
                <TextInput
                  id="os-search"
                  labelText={t.search}
                  hideLabel
                  aria-label={t.search}
                  placeholder={t.searchPlaceholder}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Layer>
              <p className="muted small count" role="status">
                {found === null ? t.savedCount(entries.length) : t.hitCount(found.totalHits, found.partial)}
              </p>
              {snapshot.ready && entries.length === 0 && <p className="muted">{t.noneYet}</p>}
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
                        title={sheets.length > 0 ? t.usedBy(sheets.join(t.listSeparator)) : undefined}
                      >
                        <span className="os-item-head">
                          <span className="mono">{e.os}</span>
                          {sheets.length > 0 && (
                            <Tag as="span" type="blue" size="sm" className="badge">
                              {t.sheetBadge(sheets.length)}
                            </Tag>
                          )}
                        </span>
                        <span className="muted small">
                          {hit && hit.columns.length > 0 ? hit.columns.map((c) => c.title ?? c.name).join(t.itemColumnsJoin) : t.itemSummary(parentColumnCount(e), Object.keys(e.info.childIdAttrs).length)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
            {current === null ? (
              <section className="card">
                <p className="muted">{t.emptyDetail}</p>
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
  const t = structuresMessages().sync;
  let status: ReactNode;
  if (sync.state === "running") {
    const label = t.loading(sync.refresh, sync.done, sync.total);
    status = <ProgressBar className="sync-progress" label={label} max={Math.max(1, sync.total)} value={sync.done} />;
  } else if (sync.state === "failed") {
    status = <Notice kind="error">{sync.error ?? t.failed}</Notice>;
  } else if (sync.state === "stopped") {
    status = (
      <Notice kind="warning">{t.stopped(sync.done, sync.total)}</Notice>
    );
  } else if (sync.state === "done") {
    status = (
      <p className="muted" role="status">
        {t.done(snapshot.entries.length, sync.finishedAt !== undefined ? formatDateTime(sync.finishedAt) : null)}
      </p>
    );
  } else {
    status = <p className="muted">{connected ? t.starting : t.idle(snapshot.entries.length)}</p>;
  }
  return (
    <section className="card">
      <div className="detail-head">
        <h2>{t.heading}</h2>
        <Button kind="tertiary" size="sm" onClick={onRefreshAll} disabled={!connected || sync.state === "running"}>
          {t.refreshAll}
        </Button>
      </div>
      <p className="muted">
        {t.target} <span className="mono">{baseUrl}</span>
      </p>
      {status}
      {snapshot.apiList !== null && <ListSummary list={snapshot.apiList} />}
      {!connected && (
        <>
          <Notice kind="warning">{locked ? t.locked : t.disconnected}</Notice>
          <p className="small">
            <Link to={SETTINGS_PATH}>{t.settings}</Link>
          </p>
        </>
      )}
      {sync.failed.length > 0 && (
        <Accordion size="sm" align="start">
          <AccordionItem className="sync-failed" title={t.failedList(sync.failed.length)}>
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
        <p className="muted small">{t.storedNote}</p>
      )}
    </section>
  );
}

/** 一覧の内訳: Maximo に定義された数、API で使える数（apimeta に載らず足した数）、API で使えないため読み込まない構造 */
function ListSummary({ list }: { list: StoredApiList }) {
  const notApi = list.notApi ?? [];
  const groups = groupByUseWith(notApi);
  const added = list.addedFromDefinitions ?? 0;
  const msg = structuresMessages();
  const t = msg.list;
  return (
    <>
      <p className="muted small list-summary">
        {typeof list.definedCount === "number" ? t.defined(list.definedCount, list.items.length) : t.usable(list.items.length)}
        {added > 0 ? t.added(added) : ""}
        {t.end}
      </p>
      {notApi.length > 0 && (
        <Accordion size="sm" align="start">
          <AccordionItem
            className="not-api"
            title={t.notApi(notApi.length, groups.map((g) => t.group(g.usewith, g.names.length)).join(msg.listSeparator))}
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
        <Notice kind="warning">{t.definedError(list.definedError)}</Notice>
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

  const msg = structuresMessages();
  const t = msg.detail;
  const sourceLabel = keys.source === "schema" ? t.keySource.schema : keys.source === "inferred" ? t.keySource.inferred : t.keySource.none;
  return (
    <section className="card structure-detail" aria-label={t.label(entry.os)}>
      <div className="detail-head">
        <h2 className="mono">{entry.os}</h2>
        <div className="actions">
          <span className="muted small">{t.loadedAt(formatDateTime(entry.loadedAt))}</span>
          <Button kind="ghost" size="sm" onClick={onRefresh} disabled={!connected || refreshing}>
            {refreshing ? t.refreshing : t.refresh}
          </Button>
        </div>
      </div>
      <dl className="kv">
        <dt>{t.keyColumns}</dt>
        <dd>
          <span className="mono">{keys.keyColumns.join(", ") || t.none}</span> <span className="muted small">{t.paren(sourceLabel)}</span>
        </dd>
        <dt>{t.attributes}</dt>
        <dd>{t.attributeCounts(parentColumnCount(entry), entry.info.columns.length)}</dd>
        <dt>{t.usedBy}</dt>
        <dd className="used-sheets">{sheets.length > 0 ? sheets.join(msg.listSeparator) : <span className="muted">{t.none}</span>}</dd>
      </dl>
      {keys.note !== undefined && <p className="muted small">{keys.note}</p>}

      <h3>{t.children}</h3>
      {children.length === 0 ? (
        <p className="muted">{t.noChildren}</p>
      ) : (
        <>
          <div className="table-wrap">
            <Table size="sm" className="child-table">
              <TableHead>
                <TableRow>
                  <TableHeader>{t.childHeader}</TableHeader>
                  <TableHeader>{t.childIdHeader}</TableHeader>
                  <TableHeader>{t.columnCountHeader}</TableHeader>
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
                    <TableCell className="mono">{c.idAttr ?? <span className="muted">{t.childIdUnknown}</span>}</TableCell>
                    <TableCell>{c.columnCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="muted small">{CHILD_ID_NOTE}</p>
        </>
      )}

      <h3>{t.attributes}</h3>
      <Layer className="filter-row">
        <TextInput
          id={`attr-filter-${entry.os}`}
          size="sm"
          labelText={t.filter}
          hideLabel
          aria-label={t.filter}
          placeholder={t.filterPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        <Select
          id={`attr-scope-${entry.os}`}
          size="sm"
          labelText={t.scope}
          hideLabel
          aria-label={t.scope}
          value={scopeKey(scope)}
          onChange={(e) => setScope(parseScopeKey(e.target.value))}
        >
          <SelectItem value="all" text={t.scopeAll} />
          <SelectItem value="parent" text={t.scopeParent} />
          {children.map((c) => (
            <SelectItem key={c.name} value={`child:${c.name}`} text={t.scopeChild(c.name)} />
          ))}
        </Select>
        <span className="muted small count" role="status">
          {t.shownCount(columns.length, entry.info.columns.length)}
        </span>
      </Layer>
      <div className="attr-scroll">
        <Table size="sm" className="attr-table">
          <TableHead>
            <TableRow>
              <TableHeader>{t.attrHeader}</TableHeader>
              <TableHeader>{t.labelHeader}</TableHeader>
              <TableHeader>{t.typeHeader}</TableHeader>
              <TableHeader>{t.lengthHeader}</TableHeader>
              <TableHeader>{t.requiredHeader}</TableHeader>
              <TableHeader>{t.readOnlyHeader}</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {columns.map((c) => (
              <TableRow key={c.name}>
                <TableCell className="mono">{c.name}</TableCell>
                <TableCell>{c.title ?? ""}</TableCell>
                <TableCell>{typeLabel(c.type)}</TableCell>
                <TableCell>{c.maxLength ?? ""}</TableCell>
                <TableCell>{c.required ? t.required : ""}</TableCell>
                <TableCell>{c.readOnly ? t.readOnly : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
