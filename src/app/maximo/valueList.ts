// 属性の値の一覧（ドメイン・参照先の表）を Maximo の getlist で取る。
//
//   GET <apiRoot>/os/<os>/<レコードの ID>/getlist~<属性>?lean=1&oslc.pageSize=…
//   子の属性は子の href（…/<os>/<ID>/<子>/<子の ID>）に getlist~<属性> を付ける。
//
// getlist は Maximo の画面の「値の一覧」と同じ仕組みで、レコードの状態によって一覧が変わることがある
// （STATUS は今のステータスから移れる先、サイトで絞られる表など）。ここでは (接続先, オブジェクト構造, 列) ごとに
// 最初に取れた一覧をセッションの間だけ覚えて使い回す（手間と往復を減らすため。厳密な検査は Maximo が反映時に行う）。
// 応答の形: member の各要素に value（ALN・SYNONYM ドメイン）か属性名と同じ名前の値（表のドメイン。例 location）と
// description が入る。取れない（一覧の無い属性・権限・通信の失敗）ときは空の一覧として覚え、自由入力にする。

import { normalizeScope } from "../../shared/scope";
import type { ConnectionProvider } from "../runtime/contracts";
import { isRecord, type MaximoClient } from "./client";

export interface ValueListItem {
  value: string;
  description?: string;
}

/** 1 つの一覧で読む件数の上限（画面で選ぶための一覧なので、これより多い表はここで打ち切る） */
export const VALUE_LIST_MAX_ITEMS = 1_000;
const PAGE_SIZE = 200;
const ATTR_RE = /^[A-Za-z0-9_]+$/;

/** getlist の応答の member を一覧にする。値の重複は最初のものだけ残す */
export function parseValueList(json: unknown, attr: string): ValueListItem[] {
  if (!isRecord(json)) return [];
  const members = Array.isArray(json.member) ? json.member : [];
  const key = attr.toLowerCase();
  const out: ValueListItem[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (!isRecord(m)) continue;
    const lower = new Map<string, unknown>(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v]));
    let value = scalar(lower.get("value")) ?? scalar(lower.get(key));
    if (value === undefined) {
      // 表のドメインで属性名と違う名前の列が返るとき（例 ASSETNUM の一覧に assetnum 以外の名前）は、最初の文字列の値を使う
      for (const [k, v] of lower) {
        if (k === "href" || k === "description" || k.startsWith("_") || k.endsWith("_collectionref") || k === "localref") continue;
        const s = scalar(v);
        if (s !== undefined) {
          value = s;
          break;
        }
      }
    }
    if (value === undefined || value === "" || seen.has(value)) continue;
    seen.add(value);
    const item: ValueListItem = { value };
    const description = scalar(lower.get("description"));
    if (description !== undefined && description !== "") item.description = description;
    out.push(item);
  }
  return out;
}

function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * レコード（親または子）の href と属性名から、getlist の一覧を取る（nextPage をたどり、上限で打ち切る）。
 * 失敗したら例外（呼び出し側で静かに自由入力にする）。
 */
export async function fetchValueList(
  client: MaximoClient,
  recordHref: string,
  attr: string,
  opts: { maxItems?: number; pageSize?: number } = {},
): Promise<ValueListItem[]> {
  const maxItems = opts.maxItems ?? VALUE_LIST_MAX_ITEMS;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  if (!ATTR_RE.test(attr)) throw new Error(`Invalid attribute name ${JSON.stringify(attr)}`);
  const recordPath = client.hrefToPath(recordHref).replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!recordPath.startsWith(`${client.apiRoot}/os/`)) throw new Error("The href is not a Maximo record");
  const listPath = `${recordPath}/getlist~${attr.toLowerCase()}`;
  let path: string | null = `${listPath}?lean=1&oslc.pageSize=${pageSize}`;
  const items: ValueListItem[] = [];
  const seenValues = new Set<string>();
  const seenPaths = new Set<string>();
  while (path !== null && items.length < maxItems) {
    if (seenPaths.has(path)) break;
    seenPaths.add(path);
    const page = await client.get(path);
    for (const item of parseValueList(page, attr)) {
      if (seenValues.has(item.value)) continue;
      seenValues.add(item.value);
      items.push(item);
      if (items.length >= maxItems) break;
    }
    const info = isRecord(page) && isRecord(page.responseInfo) ? page.responseInfo : null;
    const next = info && isRecord(info.nextPage) && typeof info.nextPage.href === "string" ? info.nextPage.href : null;
    if (next === null) break;
    const nextPath = client.hrefToPath(next);
    // 同じ一覧の次のページだけをたどる
    if (!nextPath.toLowerCase().startsWith(`${listPath.toLowerCase()}?`)) break;
    path = nextPath;
  }
  return items;
}

/** 一覧の取り方（どのレコードの、どの属性の一覧か） */
export interface ValueListTarget {
  /** 読み込みに使ったオブジェクト構造 */
  os: string;
  /** シートの列名（子は CHILD.ATTR）。覚えておく単位 */
  col: string;
  /** getlist を付けるレコードの href（親、子の列なら子の href） */
  href: string;
  /** getlist~ に付ける属性名（子の列なら子の属性名） */
  attr: string;
  /** シートを読み込んだ接続先。今の接続先と違えば取らない（別の Maximo の一覧になるため） */
  baseUrl?: string;
}

export type ValueListState = { status: "loading" } | { status: "ready"; items: readonly ValueListItem[] } | { status: "none" };

/**
 * getlist の一覧をセッションの間だけ覚える。同じ一覧を同時に 2 度取りに行かない。
 * 失敗・空の一覧は "none" として覚え、同じ列では取り直さない（作業を止めず、自由入力にする）。
 */
export class ValueListService {
  private readonly connection: ConnectionProvider;
  private readonly cache = new Map<string, ValueListState>();
  private readonly pending = new Map<string, Promise<ValueListState>>();
  private readonly fetchList: typeof fetchValueList;

  constructor(opts: { connection: ConnectionProvider; fetchList?: typeof fetchValueList }) {
    this.connection = opts.connection;
    this.fetchList = opts.fetchList ?? fetchValueList;
  }

  private keyOf(baseUrl: string, os: string, col: string): string {
    return `${normalizeScope(baseUrl)}|${os.toUpperCase()}|${col.toUpperCase()}`;
  }

  /** 覚えている一覧（取っていない・接続していなければ undefined） */
  peek(os: string, col: string): ValueListState | undefined {
    const conn = this.connection.current();
    if (!conn) return undefined;
    return this.cache.get(this.keyOf(conn.client.baseUrl, os, col));
  }

  /** 一覧を返す（覚えていなければ取る）。未接続なら "none"（覚えない） */
  load(target: ValueListTarget): Promise<ValueListState> {
    const conn = this.connection.current();
    if (!conn) return Promise.resolve({ status: "none" });
    if (target.baseUrl !== undefined && normalizeScope(target.baseUrl) !== normalizeScope(conn.info.baseUrl)) return Promise.resolve({ status: "none" });
    const key = this.keyOf(conn.client.baseUrl, target.os, target.col);
    const known = this.cache.get(key);
    if (known && known.status !== "loading") return Promise.resolve(known);
    const running = this.pending.get(key);
    if (running) return running;
    this.cache.set(key, { status: "loading" });
    const p = this.fetchList(conn.client, target.href, target.attr)
      .then((items): ValueListState => (items.length > 0 ? { status: "ready", items } : { status: "none" }))
      .catch((): ValueListState => ({ status: "none" }))
      .then((state) => {
        this.cache.set(key, state);
        this.pending.delete(key);
        return state;
      });
    this.pending.set(key, p);
    return p;
  }

  /** 覚えた一覧を捨てる（接続先を変えたときなど） */
  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }
}
