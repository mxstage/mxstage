// 作業を別の窓へ移す（作業画面の「この窓に移す」）。
// 1. 移したい窓（作業が空）が POST /_mxstage/handoff/start { tabId } を送る
// 2. 橋渡しは、作業のある primary の窓に workspace.export { token } を送る
// 3. その窓は作業を直列化して POST /_mxstage/handoff/upload?token= に送る（送れないときは /refuse { token, reason }）
// 4. 橋渡しは 1 の応答として作業を返す。移したい窓はそれで作業を作り直し、POST /_mxstage/handoff/done { token } を送る
// 5. 橋渡しは送り元の窓に workspace.release を送り、送り元は作業を空にする
// 作業のデータは橋渡しのメモリを通るだけで、ファイルには書かない。どの入口も作業画面（同一オリジン）からだけ受ける。
//
// 再読み込みのあいだ預ける（作業画面の「再読み込み」。版違いのときなど）:
//   POST /_mxstage/handoff/park           本文は作業の JSON。{ token } を返す。PARK_TTL_MS で消える
//   POST /_mxstage/handoff/unpark { token } 預けた作業を 1 回だけ返して消す

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalHub } from "./hub.ts";
import { readBody } from "./peer.ts";

export const HANDOFF_PREFIX = "/_mxstage/handoff/";
export const HANDOFF_START_PATH = "/_mxstage/handoff/start";
export const HANDOFF_UPLOAD_PATH = "/_mxstage/handoff/upload";
export const HANDOFF_REFUSE_PATH = "/_mxstage/handoff/refuse";
export const HANDOFF_DONE_PATH = "/_mxstage/handoff/done";
export const HANDOFF_PARK_PATH = "/_mxstage/handoff/park";
export const HANDOFF_UNPARK_PATH = "/_mxstage/handoff/unpark";
export const HANDOFF_PATHS: readonly string[] = [HANDOFF_START_PATH, HANDOFF_UPLOAD_PATH, HANDOFF_REFUSE_PATH, HANDOFF_DONE_PATH, HANDOFF_PARK_PATH, HANDOFF_UNPARK_PATH];
/** 再読み込みのあいだ預かる時間（これを過ぎたら捨てる） */
export const PARK_TTL_MS = 10 * 60 * 1000;
/** 同時に預かる作業の数の上限（古いものから捨てる） */
const MAX_PARKED = 4;

/** 作業のデータの上限（大きなシートを数枚持つ作業でも収まるように） */
export const HANDOFF_BODY_LIMIT = 256 * 1024 * 1024;
/** 送り元が作業を送ってくるまで待つ時間 */
export const HANDOFF_WAIT_MS = 120_000;
const SMALL_BODY_LIMIT = 4 * 1024;
const TOKEN_RE = /^[0-9a-f]{32}$/;

type Outcome = { ok: true; data: Buffer } | { ok: false; status: number; error: string; message: string };

interface Pending {
  token: string;
  targetTabId: string;
  sourceTabId: string;
  /** upload か refuse で決まる */
  settle: (o: Outcome) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 作業を渡し終えた（done を待っている） */
  delivered: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(text, "utf8")), "Cache-Control": "no-store" });
  res.end(text);
}

async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, SMALL_BODY_LIMIT);
  if (body === null) return null;
  try {
    const v: unknown = JSON.parse(body.toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class Handoffs {
  private readonly pending = new Map<string, Pending>();
  private readonly parked = new Map<string, { data: Buffer; timer: ReturnType<typeof setTimeout> }>();
  private readonly waitMs: number;
  private readonly parkTtlMs: number;

  constructor(opts: { waitMs?: number; parkTtlMs?: number } = {}) {
    this.waitMs = opts.waitMs ?? HANDOFF_WAIT_MS;
    this.parkTtlMs = opts.parkTtlMs ?? PARK_TTL_MS;
  }

  /** 再読み込みのあいだ作業を預かる */
  private async park(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await readBody(req, HANDOFF_BODY_LIMIT);
    if (data === null) {
      sendJson(res, 413, { ok: false, error: "too_large", message: "The work is too large to keep." });
      return;
    }
    if (!data.subarray(0, 64).toString("utf8").trimStart().startsWith("{")) {
      sendJson(res, 400, { ok: false, error: "invalid_request", message: "Send the work as JSON." });
      return;
    }
    while (this.parked.size >= MAX_PARKED) {
      const oldest = this.parked.keys().next().value as string;
      clearTimeout(this.parked.get(oldest)?.timer);
      this.parked.delete(oldest);
    }
    const token = randomBytes(16).toString("hex");
    const timer = setTimeout(() => this.parked.delete(token), this.parkTtlMs);
    timer.unref?.();
    this.parked.set(token, { data, timer });
    sendJson(res, 200, { ok: true, token, expiresInMs: this.parkTtlMs });
  }

  /** 預けた作業を 1 回だけ返す */
  private async unpark(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readSmallJson(req);
    const token = typeof body?.token === "string" ? body.token : "";
    const p = TOKEN_RE.test(token) ? this.parked.get(token) : undefined;
    if (!p) {
      sendJson(res, 404, { ok: false, error: "unknown_token", message: "The kept work is no longer available." });
      return;
    }
    clearTimeout(p.timer);
    this.parked.delete(token);
    const head = Buffer.from('{"ok":true,"workspace":', "utf8");
    const tail = Buffer.from("}", "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(head.length + p.data.length + tail.length), "Cache-Control": "no-store" });
    res.end(Buffer.concat([head, p.data, tail]));
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, hub: LocalHub): Promise<void> {
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "Only POST is accepted." });
      return;
    }
    if (pathname === HANDOFF_PARK_PATH) return this.park(req, res);
    if (pathname === HANDOFF_UNPARK_PATH) return this.unpark(req, res);
    if (pathname === HANDOFF_START_PATH) return this.start(req, res, hub);
    if (pathname === HANDOFF_UPLOAD_PATH) return this.upload(req, res);
    if (pathname === HANDOFF_REFUSE_PATH) return this.refuse(req, res);
    return this.done(req, res, hub);
  }

  private async start(req: IncomingMessage, res: ServerResponse, hub: LocalHub): Promise<void> {
    const body = await readSmallJson(req);
    const targetTabId = body?.tabId;
    if (typeof targetTabId !== "string" || targetTabId === "") {
      sendJson(res, 400, { ok: false, error: "invalid_request", message: "Send tabId as a string." });
      return;
    }
    const token = randomBytes(16).toString("hex");
    const outcome = new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        resolve({ ok: false, status: 504, error: "handoff_timeout", message: "The window with the work did not respond." });
      }, this.waitMs);
      const sourceTabId = hub.requestExport(targetTabId, token);
      if (sourceTabId === null) {
        clearTimeout(timer);
        resolve({ ok: false, status: 409, error: "no_source", message: "No other window has work to move." });
        return;
      }
      this.pending.set(token, { token, targetTabId, sourceTabId, timer, delivered: false, settle: resolve });
    });
    // 移したい窓が待つのをやめた（閉じた・読み込み直した）ら、受け取りを待たない
    res.on("close", () => {
      const p = this.pending.get(token);
      if (p && !p.delivered) {
        clearTimeout(p.timer);
        this.pending.delete(token);
      }
    });
    const result = await outcome;
    if (!result.ok) {
      sendJson(res, result.status, { ok: false, error: result.error, message: result.message });
      return;
    }
    // 作業の JSON を解析せずに包んで返す（大きいので作り直さない）
    const head = Buffer.from(`{"ok":true,"token":"${token}","workspace":`, "utf8");
    const tail = Buffer.from("}", "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(head.length + result.data.length + tail.length), "Cache-Control": "no-store" });
    res.end(Buffer.concat([head, result.data, tail]));
  }

  private async upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
    const p = TOKEN_RE.test(token) ? this.pending.get(token) : undefined;
    if (!p || p.delivered) {
      req.resume();
      sendJson(res, 404, { ok: false, error: "unknown_token", message: "This move is no longer waiting." });
      return;
    }
    const data = await readBody(req, HANDOFF_BODY_LIMIT);
    if (data === null) {
      p.settle({ ok: false, status: 413, error: "too_large", message: "The work is too large to move." });
      clearTimeout(p.timer);
      this.pending.delete(token);
      sendJson(res, 413, { ok: false, error: "too_large", message: "The work is too large to move." });
      return;
    }
    // 中身は JSON のオブジェクトであることだけ確かめる（作り直すのは移したい窓）
    const first = data.subarray(0, 64).toString("utf8").trimStart();
    if (!first.startsWith("{")) {
      sendJson(res, 400, { ok: false, error: "invalid_request", message: "Send the work as JSON." });
      return;
    }
    clearTimeout(p.timer);
    p.delivered = true;
    // done を待つ間に、移したい窓が消えたら残らないよう、時間で片付ける
    p.timer = setTimeout(() => this.pending.delete(token), this.waitMs);
    p.settle({ ok: true, data });
    sendJson(res, 200, { ok: true });
  }

  private async refuse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readSmallJson(req);
    const token = typeof body?.token === "string" ? body.token : "";
    const p = this.pending.get(token);
    if (!p || p.delivered) {
      sendJson(res, 404, { ok: false, error: "unknown_token", message: "This move is no longer waiting." });
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(token);
    const reason = typeof body?.reason === "string" && /^[a-z_]{1,40}$/.test(body.reason) ? body.reason : "refused";
    p.settle({ ok: false, status: 409, error: reason, message: "The window with the work cannot move it now." });
    sendJson(res, 200, { ok: true });
  }

  private async done(req: IncomingMessage, res: ServerResponse, hub: LocalHub): Promise<void> {
    const body = await readSmallJson(req);
    const token = typeof body?.token === "string" ? body.token : "";
    const p = this.pending.get(token);
    if (!p || !p.delivered || body?.tabId !== p.targetTabId) {
      sendJson(res, 404, { ok: false, error: "unknown_token", message: "This move is no longer waiting." });
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(token);
    sendJson(res, 200, { ok: true, released: hub.releaseExport(p.sourceTabId, token) });
  }
}
