// 試験用の Maximo REST（MAS Manage）偽サーバ。fetch を差し替えて使う。
// 実機の挙動のうち、書き込みエンジンの安全性に関わるもの（MERGE と子の _action、MERGE 無しでの子の置き換え、
// _rowstamp、transactionid の重複 409、エラー形式、apikey 必須）を再現する。
// reasonCode は実機の値を確認していない試験用の値。

import type { CellValue } from "../../src/shared/model";

export type FakeAttrType = "string" | "integer" | "number" | "boolean" | "date" | "datetime";

export interface FakeAttrDef {
  type: FakeAttrType;
  maxLength?: number;
  required?: boolean;
  readOnly?: boolean;
  title?: string;
}

export interface FakeChildDef {
  /** 子を特定する属性（小文字）。省略した子には自動で採番する */
  idAttr: string;
  attrs: Record<string, FakeAttrDef>;
}

export interface FakeRecordSeed {
  attrs: Record<string, CellValue>;
  children?: Record<string, Array<Record<string, CellValue>>>;
}

export interface FakeOsSeed {
  description?: string;
  mbo?: string;
  /** apimeta に載せない（実機では顧客が作った EXT_* などが載らなかった。jsonschemas と行の読み取りはできる） */
  hiddenFromApimeta?: boolean;
  /** 親のキー属性（小文字） */
  keyAttrs: string[];
  attrs: Record<string, FakeAttrDef>;
  children?: Record<string, FakeChildDef>;
  records?: FakeRecordSeed[];
}

export interface FakeSeed {
  baseUrl?: string;
  apiKey?: string;
  /** Maximo が返す href のオリジン（内部ホスト名を返す実機を再現するため baseUrl と別にできる） */
  hrefOrigin?: string;
  objectStructures: Record<string, FakeOsSeed>;
}

export interface FakeChild {
  attrs: Record<string, CellValue>;
  rowstamp: number;
}

export interface FakeRecord {
  uid: string;
  rowstamp: number;
  attrs: Record<string, CellValue>;
  children: Record<string, FakeChild[]>;
}

export interface FakeOsState {
  name: string;
  def: FakeOsSeed;
  records: FakeRecord[];
}

export interface FakeRequestLog {
  method: string;
  /** fetch に渡された URL（proxy なら /mx/...） */
  url: string;
  /** Maximo 側の path+query */
  path: string;
  /** ヘッダ（小文字。API キーの値は伏せる） */
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeFailure {
  method?: "GET" | "POST";
  pathIncludes?: string;
  /** before: 処理せずに失敗させる。after: 書き込みを反映してから失敗させる（POST のみ） */
  phase?: "before" | "after";
  kind: "network" | "status";
  status?: number;
  body?: unknown;
  /** 何回失敗させるか（既定 1） */
  times?: number;
}

export interface FakeMaximo {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  state: {
    os: Record<string, FakeOsState>;
    transactionIds: Set<string>;
    requests: FakeRequestLog[];
    failures: FakeFailure[];
  };
  baseUrl: string;
  apiKey: string;
  hrefOrigin: string;
  hrefOf(os: string, uid: string): string;
  records(os: string): FakeRecord[];
  find(os: string, pred: (r: FakeRecord) => boolean): FakeRecord | undefined;
  /** 他の利用者の更新を再現する。bumpRowstamp:false で親の _rowstamp を変えずに子だけ変える */
  update(os: string, uid: string, fn: (r: FakeRecord) => void, opts?: { bumpRowstamp?: boolean }): void;
  /** 子を追加して採番した ID を返す */
  addChild(os: string, uid: string, kind: string, attrs: Record<string, CellValue>, opts?: { bumpRowstamp?: boolean }): CellValue;
  /** 書き込み（POST）の件数 */
  writeCount(): number;
}

// 引数プロパティ（constructor(readonly …)）は使わない。開発用の偽の Maximo（scripts/dev-fake-maximo.ts）は
// Node が型を消すだけで動かすので、その書き方を読めない
class FakeHttpError extends Error {
  readonly status: number;
  readonly reasonCode: string;
  constructor(status: number, reasonCode: string, message: string) {
    super(message);
    this.status = status;
    this.reasonCode = reasonCode;
  }
}

interface SelectNode {
  all: boolean;
  attrs: Set<string>;
  children: Map<string, SelectNode>;
}

type WhereClause =
  | { attr: string; op: "=" | "!=" | ">" | ">=" | "<" | "<="; value: CellValue }
  | { attr: string; op: "in"; values: CellValue[] };

export function createFakeMaximo(seed: FakeSeed): FakeMaximo {
  const baseUrl = (seed.baseUrl ?? "https://maximo.test").replace(/\/+$/, "");
  const apiKey = seed.apiKey ?? "test-api-key";
  const hrefOrigin = (seed.hrefOrigin ?? baseUrl).replace(/\/+$/, "");
  let idCounter = 1000;
  let rowstampCounter = 50_000;
  let uidCounter = 1;
  const nextRowstamp = () => ++rowstampCounter;

  const state: FakeMaximo["state"] = { os: {}, transactionIds: new Set(), requests: [], failures: [] };

  for (const [rawName, rawDef] of Object.entries(seed.objectStructures)) {
    const name = rawName.toLowerCase();
    const def = normalizeDef(rawDef);
    const records: FakeRecord[] = (rawDef.records ?? []).map((r) => {
      const attrs: Record<string, CellValue> = {};
      for (const a of Object.keys(def.attrs)) attrs[a] = null;
      for (const [k, v] of Object.entries(r.attrs)) attrs[k.toLowerCase()] = v;
      const children: Record<string, FakeChild[]> = {};
      for (const [kind, cdef] of Object.entries(def.children ?? {})) {
        children[kind] = (r.children?.[kind] ?? []).map((c) => newChild(cdef, lowerKeys(c)));
      }
      return { uid: `_R${uidCounter++}`, rowstamp: nextRowstamp(), attrs, children };
    });
    state.os[name] = { name, def, records };
  }

  function newChild(cdef: FakeChildDef, attrs: Record<string, CellValue>): FakeChild {
    const out: Record<string, CellValue> = {};
    for (const a of Object.keys(cdef.attrs)) out[a] = null;
    Object.assign(out, attrs);
    if (out[cdef.idAttr] === null || out[cdef.idAttr] === undefined) out[cdef.idAttr] = ++idCounter;
    return { attrs: out, rowstamp: nextRowstamp() };
  }

  function osOf(name: string): FakeOsState {
    const s = state.os[name.toLowerCase()];
    if (!s) throw new FakeHttpError(404, "BMXAA_FAKE_OS_NOT_FOUND", `object structure ${name} not found`);
    return s;
  }

  const hrefOf = (os: string, uid: string) => `${hrefOrigin}/maximo/api/os/${os.toLowerCase()}/${uid}`;

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : null;

    let key: string | null;
    let u: URL;
    if (rawUrl.startsWith("/mx/")) {
      // 画面は /mx を同一オリジンの要求（credentials: same-origin）として送る。送らない呼び出しは 401（/mx 自身のエラー形式）にして、送り方の誤りを試験で見つける
      // RequestInit の型によっては credentials が無いので、構造で読む
      if ((init as { credentials?: string } | undefined)?.credentials === "omit") {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized", message: "ログインが必要です。" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      if (headers.get("x-maximo-base") !== baseUrl) return errorResponse(400, "FAKE_PROXY_BASE", "X-Maximo-Base mismatch");
      key = headers.get("x-maximo-apikey");
      if (headers.has("apikey")) return errorResponse(400, "FAKE_PROXY_APIKEY", "apikey header must not be sent to proxy");
      u = new URL(rawUrl.slice(3), "http://proxy.invalid");
    } else {
      u = new URL(rawUrl);
      if (u.origin !== new URL(baseUrl).origin) throw new TypeError("Failed to fetch");
      key = headers.get("apikey");
    }
    const path = u.pathname;
    const params = u.searchParams;
    const logHeaders: Record<string, string> = {};
    headers.forEach((v, k) => {
      logHeaders[k] = k === "apikey" || k === "x-maximo-apikey" ? "<redacted>" : v;
    });
    let parsedBody: unknown = null;
    if (bodyText !== null) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = bodyText;
      }
    }
    state.requests.push({ method, url: rawUrl, path: `${path}${u.search}`, headers: logHeaders, body: parsedBody });

    for (const k of params.keys()) {
      if (k.toLowerCase() === "apikey") return errorResponse(400, "FAKE_APIKEY_IN_QUERY", "apikey must not be in query");
    }
    if (!key || key !== apiKey) return errorResponse(401, "BMXAA7901E", "You cannot log in at this time.");

    const failure = takeFailure(method, path, "before");
    if (failure) return fail(failure);

    try {
      const res = route(method, path, params, headers, parsedBody, bodyText);
      if (method === "POST" && res.status < 300) {
        const after = takeFailure(method, path, "after");
        if (after) return fail(after);
      }
      return res;
    } catch (e) {
      if (e instanceof FakeHttpError) return errorResponse(e.status, e.reasonCode, e.message);
      throw e;
    }
  }

  function takeFailure(method: string, path: string, phase: "before" | "after"): FakeFailure | null {
    const idx = state.failures.findIndex(
      (f) => (f.phase ?? "before") === phase && (!f.method || f.method === method) && (!f.pathIncludes || path.includes(f.pathIncludes)),
    );
    if (idx < 0) return null;
    const f = state.failures[idx]!;
    const times = (f.times ?? 1) - 1;
    if (times <= 0) state.failures.splice(idx, 1);
    else state.failures[idx] = { ...f, times };
    return f;
  }

  function fail(f: FakeFailure): Response {
    if (f.kind === "network") throw new TypeError("Failed to fetch");
    const status = f.status ?? 500;
    if (status === 204) return new Response(null, { status });
    return new Response(f.body === undefined ? "" : JSON.stringify(f.body), { status, headers: { "content-type": "application/json" } });
  }

  function route(method: string, path: string, params: URLSearchParams, headers: Headers, body: unknown, bodyText: string | null): Response {
    const m = /^\/maximo\/api\/(.+)$/.exec(path);
    if (!m) throw new FakeHttpError(404, "BMXAA_FAKE_NOT_FOUND", "not found");
    const segs = m[1]!.split("/").map((s) => decodeURIComponent(s));
    if (segs[0] === "apimeta" && segs.length === 1 && method === "GET") {
      return json(
        200,
        Object.values(state.os)
          .filter((s) => s.def.hiddenFromApimeta !== true)
          .map((s) => ({
            name: s.name.toUpperCase(),
            description: s.def.description ?? "",
            href: `${hrefOrigin}/maximo/api/os/${s.name}`,
            schema: `${hrefOrigin}/maximo/api/jsonschemas/${s.name}`,
          })),
      );
    }
    if (segs[0] === "jsonschemas" && segs.length === 2 && method === "GET") return json(200, schemaOf(osOf(segs[1]!)));
    if (segs[0] === "os" && segs.length === 2 && method === "GET") return collection(osOf(segs[1]!), params);
    if (segs[0] === "os" && segs.length === 3) {
      const os = osOf(segs[1]!);
      const rec = os.records.find((r) => r.uid === segs[2]);
      if (!rec) throw new FakeHttpError(404, "BMXAA_FAKE_RECORD_NOT_FOUND", "record not found");
      if (method === "GET") {
        requireLean(params);
        const sel = params.get("oslc.select");
        const node = sel ? parseSelect(sel) : null;
        if (node) validateSelect(os.def, node);
        return json(200, render(os, rec, node, true));
      }
      if (method === "POST") {
        if ((headers.get("x-method-override") ?? "").toUpperCase() !== "PATCH") {
          throw new FakeHttpError(400, "BMXAA_FAKE_METHOD", "only PATCH via x-method-override is supported");
        }
        requireLean(params);
        if (bodyText === null || typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new FakeHttpError(400, "BMXAA_FAKE_BODY", "body must be a JSON object");
        }
        return patch(os, rec, headers, body as Record<string, unknown>);
      }
    }
    throw new FakeHttpError(404, "BMXAA_FAKE_NOT_FOUND", "not found");
  }

  function requireLean(params: URLSearchParams): void {
    if (params.get("lean") !== "1") throw new FakeHttpError(400, "BMXAA_FAKE_LEAN", "fake supports lean=1 only");
  }

  function collection(os: FakeOsState, params: URLSearchParams): Response {
    requireLean(params);
    const sel = params.get("oslc.select");
    const node = sel ? parseSelect(sel) : null;
    if (node) validateSelect(os.def, node);
    const whereText = params.get("oslc.where");
    const clauses = whereText ? parseWhere(whereText) : [];
    for (const c of clauses) {
      if (!(c.attr in os.def.attrs)) throw new FakeHttpError(400, "BMXAA8744E", `unknown attribute in where: ${c.attr}`);
    }
    let rows = os.records.filter((r) => clauses.every((c) => evalClause(r.attrs[c.attr] ?? null, c)));
    const orderBy = params.get("oslc.orderBy");
    if (orderBy) {
      const keys = orderBy.split(",").map((s) => ({ desc: s.startsWith("-"), attr: s.replace(/^[+-]/, "").toLowerCase() }));
      rows = [...rows].sort((a, b) => {
        for (const k of keys) {
          const c = compare(a.attrs[k.attr] ?? null, b.attrs[k.attr] ?? null);
          if (c !== 0) return k.desc ? -c : c;
        }
        return 0;
      });
    }
    const pageSize = Math.max(1, Number(params.get("oslc.pageSize") ?? "1000") || 1000);
    const pageno = Math.max(1, Number(params.get("pageno") ?? "1") || 1);
    const slice = rows.slice((pageno - 1) * pageSize, pageno * pageSize);
    const responseInfo: Record<string, unknown> = { pagenum: pageno, href: `${hrefOrigin}/maximo/api/os/${os.name}` };
    if (params.get("collectioncount") === "1") responseInfo.totalCount = rows.length;
    if (pageno * pageSize < rows.length) {
      const next = new URLSearchParams(params);
      next.set("pageno", String(pageno + 1));
      const qs = [...next.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
      responseInfo.nextPage = { href: `${hrefOrigin}/maximo/api/os/${os.name}?${qs}` };
    }
    return json(200, { member: slice.map((r) => render(os, r, node, false)), responseInfo });
  }

  function render(os: FakeOsState, rec: FakeRecord, node: SelectNode | null, single: boolean): Record<string, unknown> {
    const href = hrefOf(os.name, rec.uid);
    const out: Record<string, unknown> = { href };
    if (node === null) {
      if (!single) return out;
      node = { all: true, attrs: new Set(), children: new Map() };
    }
    if (node.all || node.attrs.has("_rowstamp")) out._rowstamp = String(rec.rowstamp);
    for (const a of Object.keys(os.def.attrs)) {
      const v = rec.attrs[a];
      // lean 形式では null の属性を省略する
      if ((node.all || node.attrs.has(a)) && v !== null && v !== undefined) out[a] = v;
    }
    for (const [kind, cdef] of Object.entries(os.def.children ?? {})) {
      const cnode = node.children.get(kind);
      if (!cnode) continue;
      const list = rec.children[kind] ?? [];
      if (list.length === 0) continue;
      out[kind] = list.map((c) => {
        const item: Record<string, unknown> = {};
        for (const a of Object.keys(cdef.attrs)) {
          const v = c.attrs[a];
          if ((cnode.all || cnode.attrs.has(a)) && v !== null && v !== undefined) item[a] = v;
        }
        if (cnode.all || cnode.attrs.has("_rowstamp")) item._rowstamp = String(c.rowstamp);
        item.href = `${href}/${kind}/${String(c.attrs[cdef.idAttr])}`;
        return item;
      });
    }
    return out;
  }

  function patch(os: FakeOsState, rec: FakeRecord, headers: Headers, body: Record<string, unknown>): Response {
    const txid = headers.get("transactionid");
    if (txid && state.transactionIds.has(txid)) throw new FakeHttpError(409, "BMXAA9549E", "transaction already processed");
    const merge = (headers.get("patchtype") ?? "").toUpperCase() === "MERGE";
    const draft: FakeRecord = JSON.parse(JSON.stringify(rec));
    const changedChildren: string[] = [];
    for (const [rawKey, v] of Object.entries(body)) {
      const key = rawKey.toLowerCase();
      const cdef = os.def.children?.[key];
      if (cdef) {
        if (!Array.isArray(v)) throw new FakeHttpError(400, "BMXAA_FAKE_CHILD_ARRAY", `${key} must be an array`);
        applyChildren(draft, key, cdef, v, merge);
        changedChildren.push(key);
        continue;
      }
      const adef = os.def.attrs[key];
      if (!adef || key.startsWith("_")) throw new FakeHttpError(400, "BMXAA_FAKE_UNKNOWN_ATTR", `attribute ${key} does not exist`);
      if (os.def.keyAttrs.includes(key) && v !== rec.attrs[key]) throw new FakeHttpError(400, "BMXAA0031E", `key attribute ${key} is read-only`);
      if (adef.readOnly) throw new FakeHttpError(400, "BMXAA0031E", `attribute ${key} is read-only`);
      checkValue(key, adef, v);
      draft.attrs[key] = (v ?? null) as CellValue;
    }
    draft.rowstamp = nextRowstamp();
    rec.attrs = draft.attrs;
    rec.children = draft.children;
    rec.rowstamp = draft.rowstamp;
    if (txid) state.transactionIds.add(txid);
    if (headers.get("properties")) return json(200, render(os, rec, { all: true, attrs: new Set(), children: new Map() }, true));
    return new Response(null, { status: 204 });
  }

  function applyChildren(draft: FakeRecord, kind: string, cdef: FakeChildDef, items: unknown[], merge: boolean): void {
    const current = draft.children[kind] ?? [];
    const idA = cdef.idAttr;
    const findIdx = (list: FakeChild[], id: unknown) => list.findIndex((c) => String(c.attrs[idA]) === String(id));
    // MERGE: 送った子だけを操作する。MERGE 無し: 送った配列で子コレクションを置き換える（送らなかった子は消える）
    const result: FakeChild[] = merge ? [...current] : [];
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new FakeHttpError(400, "BMXAA_FAKE_CHILD_ITEM", "child item must be an object");
      const item = lowerKeys(raw as Record<string, CellValue>);
      const action = item._action;
      delete item._action;
      const idv = item[idA];
      delete item[idA];
      for (const [a, v] of Object.entries(item)) {
        const adef = cdef.attrs[a];
        if (!adef || a.startsWith("_")) throw new FakeHttpError(400, "BMXAA_FAKE_UNKNOWN_ATTR", `attribute ${kind}.${a} does not exist`);
        if (adef.readOnly) throw new FakeHttpError(400, "BMXAA0031E", `attribute ${kind}.${a} is read-only`);
        checkValue(`${kind}.${a}`, adef, v);
      }
      if (action === "Delete") {
        if (idv === null || idv === undefined) throw new FakeHttpError(400, "BMXAA_FAKE_CHILD_ID", "Delete requires id");
        if (findIdx(current, idv) < 0) throw new FakeHttpError(400, "BMXAA_FAKE_CHILD_NOT_FOUND", "child not found");
        const i = findIdx(result, idv);
        if (i >= 0) result.splice(i, 1);
        continue;
      }
      if (idv !== null && idv !== undefined) {
        if (action !== undefined && action !== "Change" && action !== "AddChange") throw new FakeHttpError(400, "BMXAA_FAKE_ACTION", `bad _action ${String(action)}`);
        const ci = findIdx(current, idv);
        if (ci < 0) throw new FakeHttpError(400, "BMXAA_FAKE_CHILD_NOT_FOUND", "child not found");
        const updated: FakeChild = { attrs: { ...current[ci]!.attrs, ...item }, rowstamp: nextRowstamp() };
        const ri = findIdx(result, idv);
        if (ri >= 0) result[ri] = updated;
        else result.push(updated);
        continue;
      }
      if (action !== undefined && action !== "Add" && action !== "AddChange") throw new FakeHttpError(400, "BMXAA_FAKE_ACTION", `${String(action)} requires id`);
      result.push(newChild(cdef, item));
    }
    draft.children[kind] = result;
  }

  function checkValue(name: string, def: FakeAttrDef, v: unknown): void {
    if (v === null) return;
    const ok =
      def.type === "integer"
        ? Number.isInteger(v)
        : def.type === "number"
          ? typeof v === "number"
          : def.type === "boolean"
            ? typeof v === "boolean"
            : typeof v === "string";
    if (!ok) throw new FakeHttpError(400, "BMXAA_FAKE_TYPE", `bad value type for ${name}`);
    if (typeof v === "string" && def.maxLength !== undefined && v.length > def.maxLength) {
      throw new FakeHttpError(400, "BMXAA_FAKE_LENGTH", `value too long for ${name}`);
    }
  }

  function schemaOf(os: FakeOsState): Record<string, unknown> {
    const propOf = (d: FakeAttrDef): Record<string, unknown> => {
      const p: Record<string, unknown> = {};
      switch (d.type) {
        case "integer":
          Object.assign(p, { type: "integer", subType: "INTEGER" });
          break;
        case "number":
          Object.assign(p, { type: "number", subType: "DECIMAL" });
          break;
        case "boolean":
          Object.assign(p, { type: "boolean", subType: "YORN" });
          break;
        case "date":
          Object.assign(p, { type: "string", subType: "DATE", format: "date" });
          break;
        case "datetime":
          Object.assign(p, { type: "string", subType: "DATETIME", format: "date-time" });
          break;
        default:
          Object.assign(p, { type: "string", subType: "ALN" });
      }
      if (d.maxLength !== undefined) p.maxLength = d.maxLength;
      if (d.title) p.title = d.title;
      if (d.readOnly) p.readOnly = true;
      return p;
    };
    const properties: Record<string, unknown> = { _rowstamp: { type: "string" }, href: { type: "string" } };
    for (const [a, d] of Object.entries(os.def.attrs)) properties[a] = propOf(d);
    for (const [kind, cdef] of Object.entries(os.def.children ?? {})) {
      const cprops: Record<string, unknown> = { _rowstamp: { type: "string" }, href: { type: "string" }, localref: { type: "string" } };
      for (const [a, d] of Object.entries(cdef.attrs)) cprops[a] = propOf(d);
      properties[kind] = {
        type: "array",
        cardinality: "multiple",
        objectName: kind.toUpperCase(),
        items: {
          type: "object",
          resource: kind.toUpperCase(),
          required: Object.entries(cdef.attrs).filter(([, d]) => d.required).map(([a]) => a),
          properties: cprops,
        },
      };
    }
    return {
      $schema: "http://json-schema.org/draft-04/schema#",
      resource: os.name.toUpperCase(),
      title: os.def.mbo ?? os.name.toUpperCase(),
      description: os.def.description ?? "",
      pk: os.def.keyAttrs,
      required: Object.entries(os.def.attrs).filter(([, d]) => d.required).map(([a]) => a),
      type: "object",
      properties,
    };
  }

  function validateSelect(def: FakeOsSeed, node: SelectNode): void {
    for (const a of node.attrs) {
      if (a !== "_rowstamp" && a !== "href" && !(a in def.attrs)) throw new FakeHttpError(400, "BMXAA_FAKE_SELECT", `unknown attribute in select: ${a}`);
    }
    for (const [kind, cnode] of node.children) {
      const cdef = def.children?.[kind];
      if (!cdef) throw new FakeHttpError(400, "BMXAA_FAKE_SELECT", `unknown child in select: ${kind}`);
      for (const a of cnode.attrs) {
        if (a !== "_rowstamp" && a !== "href" && !(a in cdef.attrs)) throw new FakeHttpError(400, "BMXAA_FAKE_SELECT", `unknown attribute in select: ${kind}.${a}`);
      }
    }
  }

  function records(os: string): FakeRecord[] {
    return osOf(os).records;
  }

  return {
    fetch: fakeFetch,
    state,
    baseUrl,
    apiKey,
    hrefOrigin,
    hrefOf,
    records,
    find: (os, pred) => records(os).find(pred),
    update(os, uid, fn, opts) {
      const rec = records(os).find((r) => r.uid === uid);
      if (!rec) throw new Error(`record ${uid} not found`);
      fn(rec);
      if (opts?.bumpRowstamp !== false) rec.rowstamp = nextRowstamp();
    },
    addChild(os, uid, kind, attrs, opts) {
      const s = osOf(os);
      const rec = s.records.find((r) => r.uid === uid);
      const cdef = s.def.children?.[kind.toLowerCase()];
      if (!rec || !cdef) throw new Error("record or child not found");
      const child = newChild(cdef, lowerKeys(attrs));
      (rec.children[kind.toLowerCase()] ??= []).push(child);
      if (opts?.bumpRowstamp !== false) rec.rowstamp = nextRowstamp();
      return child.attrs[cdef.idAttr] ?? null;
    },
    writeCount: () => state.requests.filter((r) => r.method === "POST").length,
  };
}

function normalizeDef(def: FakeOsSeed): FakeOsSeed {
  const attrs = lowerKeys(def.attrs);
  const children: Record<string, FakeChildDef> = {};
  for (const [k, c] of Object.entries(def.children ?? {})) children[k.toLowerCase()] = { idAttr: c.idAttr.toLowerCase(), attrs: lowerKeys(c.attrs) };
  return { ...def, keyAttrs: def.keyAttrs.map((k) => k.toLowerCase()), attrs, children };
}

function lowerKeys<V>(obj: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, reasonCode: string, message: string): Response {
  return json(status, { Error: { reasonCode, message, statusCode: String(status) } });
}

// ---- oslc.select / oslc.where の解析（試験で使う範囲） ----

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') inStr = !inStr;
    if (!inStr) {
      if (ch === "{" || ch === "[") depth++;
      if (ch === "}" || ch === "]") depth--;
      if (depth === 0 && s.startsWith(sep, i)) {
        out.push(cur);
        cur = "";
        i += sep.length - 1;
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSelect(s: string): SelectNode {
  const node: SelectNode = { all: false, attrs: new Set(), children: new Map() };
  for (const raw of splitTop(s, ",")) {
    const t = raw.trim().toLowerCase();
    if (t === "") continue;
    if (t === "*") {
      node.all = true;
      continue;
    }
    const b = t.indexOf("{");
    if (b >= 0) {
      if (!t.endsWith("}")) throw new FakeHttpError(400, "BMXAA_FAKE_SELECT", "bad select");
      node.children.set(t.slice(0, b), parseSelect(t.slice(b + 1, -1)));
      continue;
    }
    if (!/^[a-z0-9_]+$/.test(t)) throw new FakeHttpError(400, "BMXAA_FAKE_SELECT", "bad select");
    node.attrs.add(t);
  }
  return node;
}

function parseValue(s: string): CellValue {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    const inner = t.slice(1, -1);
    if (inner.includes('"')) throw new FakeHttpError(400, "BMXAA8744E", "bad string literal");
    return inner;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  throw new FakeHttpError(400, "BMXAA8744E", `bad value ${t}`);
}

function parseWhere(s: string): WhereClause[] {
  return splitTop(s, " and ").map((raw) => {
    const t = raw.trim();
    const inM = /^([A-Za-z0-9_]+)\s+in\s+\[(.*)\]$/.exec(t);
    if (inM) return { attr: inM[1]!.toLowerCase(), op: "in" as const, values: splitTop(inM[2]!, ",").map(parseValue) };
    const m = /^([A-Za-z0-9_]+)\s*(!=|>=|<=|=|>|<)\s*(.+)$/.exec(t);
    if (!m) throw new FakeHttpError(400, "BMXAA8744E", `bad where clause`);
    return { attr: m[1]!.toLowerCase(), op: m[2] as "=" | "!=" | ">" | ">=" | "<" | "<=", value: parseValue(m[3]!) };
  });
}

function eqValue(rv: CellValue, v: CellValue): boolean {
  if (rv === null) return false;
  if (typeof v === "number") return Number(rv) === v;
  if (typeof v === "boolean") return rv === v;
  return String(rv) === v;
}

function compare(a: CellValue, b: CellValue): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

function evalClause(rv: CellValue, c: WhereClause): boolean {
  if (c.op === "in") return c.values.some((v) => eqValue(rv, v));
  const v = c.value;
  if (c.op === "=" && v === "*") return rv !== null && rv !== "";
  if (c.op === "!=" && v === "*") return rv === null || rv === "";
  if (c.op === "=" && typeof v === "string" && v.includes("%")) {
    if (rv === null) return false;
    const re = new RegExp(`^${v.split("%").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(String(rv));
  }
  switch (c.op) {
    case "=":
      return eqValue(rv, v);
    case "!=":
      return rv !== null && !eqValue(rv, v);
    case ">":
      return rv !== null && compare(rv, v) > 0;
    case ">=":
      return rv !== null && compare(rv, v) >= 0;
    case "<":
      return rv !== null && compare(rv, v) < 0;
    case "<=":
      return rv !== null && compare(rv, v) <= 0;
  }
}

// ---- 試験で共通に使う定義 ----

/**
 * Maximo の定義の一覧（オブジェクト構造 MXAPIINTOBJECT）を seed に足す。seed のすべての構造（apimeta に載らないものも）を
 * 適用先 usewith で載せ、notApi は定義だけあって API で使えない構造（例 マイグレーション・マネージャー。jsonschemas も無い）。
 */
export function withDefinitions(seed: FakeSeed, notApi: Array<{ name: string; usewith: string; description?: string }> = [], usewith = "統合"): FakeSeed {
  const names = [...Object.keys(seed.objectStructures), "MXAPIINTOBJECT"];
  seed.objectStructures.MXAPIINTOBJECT = {
    description: "Object Structure",
    keyAttrs: ["intobjectname"],
    attrs: {
      intobjectname: { type: "string", maxLength: 20, required: true, title: "オブジェクト構造" },
      description: { type: "string", maxLength: 100, title: "説明" },
      usewith: { type: "string", maxLength: 18, required: true, title: "適用先" },
    },
    records: [
      ...names.map((name) => ({ attrs: { intobjectname: name, description: seed.objectStructures[name]?.description ?? "Object Structure", usewith } })),
      ...notApi.map((d) => ({ attrs: { intobjectname: d.name, description: d.description ?? null, usewith: d.usewith } })),
    ],
  };
  return seed;
}

/**
 * WO（MXAPIWO）と子 MULTIASSETLOCCI・EXT_WOPERMIT、資産（MXASSET）の定義。
 * 子の ID は定義順に 1001 から採番される（WO1001: MULTIID 1001〜1003、EXT_WOPERMITID 1004 / WO1002: MULTIID 1005）。
 */
export function sampleSeed(opts: { woRecords?: FakeRecordSeed[]; hrefOrigin?: string; baseUrl?: string } = {}): FakeSeed {
  const seed: FakeSeed = {
    objectStructures: {
      MXAPIWO: {
        description: "Work Order",
        mbo: "WORKORDER",
        keyAttrs: ["siteid", "wonum"],
        attrs: {
          siteid: { type: "string", maxLength: 8, required: true, title: "Site" },
          wonum: { type: "string", maxLength: 12, required: true, title: "Work Order" },
          description: { type: "string", maxLength: 100 },
          status: { type: "string", maxLength: 16 },
          estdur: { type: "number" },
          wopriority: { type: "integer" },
          reportdate: { type: "datetime" },
          targstartdate: { type: "date" },
          ext_flag: { type: "boolean" },
          changeby: { type: "string", maxLength: 30, readOnly: true },
        },
        children: {
          multiassetlocci: {
            idAttr: "multiid",
            attrs: {
              multiid: { type: "integer", readOnly: true },
              assetnum: { type: "string", maxLength: 25 },
              location: { type: "string", maxLength: 25 },
              isprimary: { type: "boolean" },
              sequence: { type: "integer" },
            },
          },
          ext_wopermit: {
            idAttr: "ext_wopermitid",
            attrs: {
              ext_wopermitid: { type: "integer", readOnly: true },
              ext_authority: { type: "string", maxLength: 40 },
              ext_permittype: { type: "string", maxLength: 40 },
              ext_permitdate: { type: "date" },
              ext_memo: { type: "string", maxLength: 200 },
            },
          },
        },
        records: opts.woRecords ?? [
          {
            attrs: { siteid: "BEDFORD", wonum: "WO1001", description: "ポンプ点検", status: "WAPPR", estdur: 1.5, wopriority: 2 },
            children: {
              multiassetlocci: [
                { assetnum: "P-100", location: "L1", isprimary: true, sequence: 1 },
                { assetnum: "P-101", location: "L1", isprimary: false, sequence: 2 },
                { assetnum: "P-102", location: "L2", isprimary: false, sequence: 3 },
              ],
              ext_wopermit: [{ ext_authority: "消防", ext_permittype: "届出", ext_permitdate: "2026-04-01" }],
            },
          },
          {
            attrs: { siteid: "BEDFORD", wonum: "WO1002", description: "配管更新", status: "APPR", estdur: 8, wopriority: 1 },
            children: { multiassetlocci: [{ assetnum: "V-200", location: "L3", isprimary: true, sequence: 1 }] },
          },
          { attrs: { siteid: "BEDFORD", wonum: "WO1003", description: "塗装", status: "COMP" } },
          { attrs: { siteid: "BEDFORD", wonum: "WO1004", description: "計器校正", status: "WAPPR", wopriority: 3 } },
          { attrs: { siteid: "TKY", wonum: "WO1005", description: "ポンプ交換", status: "INPRG", estdur: 4 } },
        ],
      },
      MXASSET: {
        description: "Asset",
        keyAttrs: ["siteid", "assetnum"],
        attrs: { siteid: { type: "string", required: true }, assetnum: { type: "string", required: true }, description: { type: "string" } },
        records: [],
      },
    },
  };
  if (opts.hrefOrigin !== undefined) seed.hrefOrigin = opts.hrefOrigin;
  if (opts.baseUrl !== undefined) seed.baseUrl = opts.baseUrl;
  return seed;
}
