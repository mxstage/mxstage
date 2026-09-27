// Excel などの単回アップロード（ローカル版）。橋渡しは保存せず、断片ごとに Hub 経由で作業タブへ流す。
// 署名付きチケットの代わりに、ランダムな importId をメモリに置いて 1 回だけ使えるようにする
// （ローカルは 127.0.0.1 に来られる人だけが使えるため）。

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubRpc, ImportChunkMsg } from "../shared/protocol.ts";

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_TICKET_TTL_MS = 600_000;
/** 生バイトでこの大きさごとに送る（base64 で約 683KB。WebSocket 1 フレームの上限 1MiB に収まる） */
export const IMPORT_CHUNK_BYTES = 512 * 1024;

const MAX_TICKETS = 64;

export interface ImportTicket {
  importId: string;
  expiresAt: number;
  maxBytes: number;
}

/** 発行済みチケット（プロセスのメモリだけに置く） */
export class ImportTickets {
  private readonly tickets = new Map<string, ImportTicket>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  create(): ImportTicket {
    this.sweep();
    const ticket: ImportTicket = { importId: randomBytes(9).toString("hex"), expiresAt: this.now() + IMPORT_TICKET_TTL_MS, maxBytes: IMPORT_MAX_BYTES };
    this.tickets.set(ticket.importId, ticket);
    while (this.tickets.size > MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    return ticket;
  }

  /** 使う直前に取り出す（同じ URL の二重利用を防ぐ）。戻せるように put も用意する */
  take(importId: string): ImportTicket | "expired" | null {
    const ticket = this.tickets.get(importId);
    if (!ticket) return null;
    this.tickets.delete(importId);
    if (ticket.expiresAt <= this.now()) return "expired";
    return ticket;
  }

  /** 1 断片も届かなかったときに戻す（作業画面を開いてから同じ URL で再実行できるように） */
  put(ticket: ImportTicket): void {
    if (ticket.expiresAt > this.now()) this.tickets.set(ticket.importId, ticket);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, t] of [...this.tickets]) {
      if (t.expiresAt <= now) this.tickets.delete(id);
    }
  }
}

/** ヘッダのファイル名から制御文字とパス区切りを除く */
export function sanitizeFileName(value: string | undefined): string {
  if (!value) return "upload.xlsx";
  let name = value;
  try {
    name = decodeURIComponent(value);
  } catch {
    // 符号化されていなければそのまま使う
  }
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^.*[\\/]/, "")
    .trim()
    .slice(0, 200);
  return name || "upload.xlsx";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function fail(res: ServerResponse, status: number, error: string, message: string, headers?: Record<string, string>): void {
  if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  json(res, status, { ok: false, error, message });
}

const NO_TAB_BODY = {
  ok: false,
  error: "NO_TAB",
  message: "作業画面のタブが開いていません。ブラウザで作業画面を開いてから、同じコマンドをもう一度実行してください。",
};

/** POST /import/:importId を受けて、断片を作業タブへ流す */
export async function handleImportUpload(
  req: IncomingMessage,
  res: ServerResponse,
  importId: string,
  tickets: ImportTickets,
  hub: Pick<HubRpc, "pushImport">,
): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    fail(res, 405, "method_not_allowed", "POST だけを受け付けます。", { Allow: "POST" });
    return;
  }
  const ticket = tickets.take(importId);
  if (ticket === "expired") {
    fail(res, 410, "ticket_expired", "アップロード URL の有効期限が切れました。create_import_session からやり直してください。");
    return;
  }
  if (!ticket) {
    fail(res, 403, "ticket_invalid", "アップロード URL が不正か、既に使用済みです。create_import_session からやり直してください。");
    return;
  }

  const lengthHeader = req.headers["content-length"];
  const contentLength = typeof lengthHeader === "string" ? Number(lengthHeader) : NaN;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    tickets.put(ticket);
    fail(res, 411, "length_required", "Content-Length が必要です（curl --data-binary @file で送ってください）。");
    return;
  }
  if (contentLength > ticket.maxBytes) {
    tickets.put(ticket);
    fail(res, 413, "too_large", `ファイルが大きすぎます（上限 ${ticket.maxBytes} バイト）。`);
    return;
  }
  if (contentLength === 0) {
    tickets.put(ticket);
    fail(res, 400, "empty_body", "ファイルの内容が空です。");
    return;
  }

  const fileNameHeader = req.headers["x-file-name"];
  const fileName = sanitizeFileName(Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader);
  const typeHeader = req.headers["content-type"];
  const contentType = ((Array.isArray(typeHeader) ? typeHeader[0] : typeHeader) || "application/octet-stream").slice(0, 200);

  const digest = createHash("sha256");
  let seq = 0;
  let bytes = 0;
  let pending = Buffer.allocUnsafe(IMPORT_CHUNK_BYTES);
  let fill = 0;

  const send = async (chunk: Buffer, last: boolean): Promise<boolean> => {
    const msg: ImportChunkMsg = {
      type: "import.chunk",
      importId: ticket.importId,
      seq,
      data: chunk.toString("base64"),
      last,
      fileName,
      contentType,
      totalBytes: contentLength,
    };
    let delivered = false;
    try {
      delivered = (await hub.pushImport(msg)).delivered;
    } catch {
      delivered = false;
    }
    if (!delivered) return false;
    seq += 1;
    return true;
  };

  try {
    for await (const value of req) {
      const chunk = value as Buffer;
      bytes += chunk.byteLength;
      if (bytes > ticket.maxBytes || bytes > contentLength) {
        req.destroy();
        if (seq === 0) tickets.put(ticket);
        fail(res, 413, "too_large", "ファイルが宣言された大きさを超えています。");
        return;
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (fill === IMPORT_CHUNK_BYTES) {
          // 続きのデータがあるときだけ満杯の断片を送る（最後の断片に last:true を付けるため）
          if (!(await send(pending, false))) {
            req.destroy();
            if (seq === 0) {
              tickets.put(ticket);
              json(res, 409, NO_TAB_BODY);
            } else {
              fail(res, 409, "TAB_DISCONNECTED", "転送中に作業画面との接続が切れました。作業画面を開き直し、create_import_session からやり直してください。");
            }
            return;
          }
          pending = Buffer.allocUnsafe(IMPORT_CHUNK_BYTES);
          fill = 0;
        }
        const n = Math.min(IMPORT_CHUNK_BYTES - fill, chunk.byteLength - offset);
        chunk.copy(pending, fill, offset, offset + n);
        fill += n;
        offset += n;
      }
    }
  } catch {
    if (seq === 0) tickets.put(ticket);
    fail(res, 400, "read_failed", "ファイルの受信に失敗しました。");
    return;
  }

  if (bytes !== contentLength) {
    if (seq === 0) tickets.put(ticket);
    fail(res, 400, "length_mismatch", "受信したバイト数が Content-Length と一致しません。");
    return;
  }
  if (!(await send(pending.subarray(0, fill), true))) {
    if (seq === 0) {
      tickets.put(ticket);
      json(res, 409, NO_TAB_BODY);
    } else {
      fail(res, 409, "TAB_DISCONNECTED", "転送中に作業画面との接続が切れました。作業画面を開き直し、create_import_session からやり直してください。");
    }
    return;
  }

  json(res, 200, { ok: true, importId: ticket.importId, bytes, sha256: digest.digest("hex") });
}
