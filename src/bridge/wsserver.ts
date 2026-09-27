// WebSocket（RFC 6455）のサーバ側。依存を増やさないため Node の標準モジュールだけで実装する。
// 使うのはテキストフレームだけ（作業タブとの mxrelay.v1 は JSON 文字列）。
// 受信の中身（ツールの引数・結果・ファイル）は console に出さない。

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** http サーバの upgrade で渡るソケット（net.Socket だが型は Duplex なので必要な分だけ足す） */
export type UpgradeSocket = Duplex & {
  setNoDelay?(noDelay?: boolean): unknown;
  setTimeout?(ms: number): unknown;
  readonly remoteAddress?: string | undefined;
};

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/** 1 メッセージの上限。これを超えたら 1009 で閉じる（Hub の TOO_LARGE 判定より大きくしておく） */
export const MAX_MESSAGE_BYTES = 33_554_432;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const EMPTY = Buffer.alloc(0);

/** close フレームを書いたあと、相手の FIN を待つ上限 */
const DESTROY_GRACE_MS = 1_000;

/** Hub が使う最小限の WebSocket（試験では偽物を渡せるようにする） */
export interface BridgeSocket {
  readonly connId: string;
  readonly readyState: number;
  send(text: string): boolean;
  close(code?: number, reason?: string): void;
  onmessage: ((text: string) => void) | null;
  onclose: ((code: number) => void) | null;
}

interface FrameHeader {
  fin: boolean;
  opcode: number;
  payloadLen: number;
  mask: Buffer | null;
  headerLen: number;
}

/** Sec-WebSocket-Accept を計算する */
export function computeAccept(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Sec-WebSocket-Protocol ヘッダの候補 */
export function requestedProtocols(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** ヘッダを読んでフレームの先頭を解釈する。足りなければ null、壊れていれば "error" */
export function parseFrameHeader(buf: Buffer): FrameHeader | null | "error" {
  if (buf.length < 2) return null;
  const b0 = buf[0] as number;
  const b1 = buf[1] as number;
  const fin = (b0 & 0x80) !== 0;
  if ((b0 & 0x70) !== 0) return "error"; // 拡張（RSV）は使わない
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return "error";
    payloadLen = Number(big);
    offset += 8;
  }
  // クライアントからのフレームは必ずマスクされている
  if (!masked) return "error";
  if (buf.length < offset + 4) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  // 制御フレームは分割できず、本体は 125 バイトまで
  if (opcode >= 0x8 && (!fin || payloadLen > 125)) return "error";
  return { fin, opcode, payloadLen, mask: Buffer.from(mask), headerLen: offset };
}

/** サーバ→クライアントのフレーム（マスクしない） */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function unmask(payload: Buffer, mask: Buffer): void {
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
  }
}

class ServerSocket implements BridgeSocket {
  readonly connId: string;
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;

  private state = WS_OPEN;
  private readonly socket: UpgradeSocket;
  private buf: Buffer = EMPTY;
  private reading: "header" | "payload" = "header";
  private frame: FrameHeader | null = null;
  private payload: Buffer = EMPTY;
  private filled = 0;
  /** 分割されたメッセージの組み立て */
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private closeCode = 1006;

  constructor(socket: UpgradeSocket, connId: string) {
    this.socket = socket;
    this.connId = connId;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("error", () => this.finish(1006));
    socket.on("close", () => this.finish(this.closeCode));
    socket.on("end", () => this.finish(this.closeCode));
  }

  get readyState(): number {
    return this.state;
  }

  send(text: string): boolean {
    if (this.state !== WS_OPEN) return false;
    try {
      this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, "utf8")));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.state === WS_CLOSED || this.state === WS_CLOSING) return;
    this.state = WS_CLOSING;
    this.closeCode = code;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, "utf8");
    try {
      this.socket.write(encodeFrame(OP_CLOSE, body));
    } catch {
      // 既に切れている
    }
    try {
      this.socket.end();
    } catch {
      // 既に切れている
    }
    // 相手の close を待たずに片付ける（ローカルなので往復を待つ意味が薄い）
    this.finish(code);
  }

  /** 受信バイトを解釈する */
  private feed(chunk: Buffer): void {
    let data: Buffer = chunk;
    for (;;) {
      if (this.state === WS_CLOSED) return;
      if (this.reading === "payload") {
        const need = this.payload.length - this.filled;
        const n = Math.min(need, data.length);
        if (n > 0) {
          data.copy(this.payload, this.filled, 0, n);
          this.filled += n;
          data = data.subarray(n);
        }
        if (this.filled < this.payload.length) return;
        this.reading = "header";
        this.completeFrame();
        if (this.state === WS_CLOSED) return;
        if (data.length === 0) return;
        continue;
      }
      if (data.length > 0) {
        this.buf = this.buf.length === 0 ? Buffer.from(data) : Buffer.concat([this.buf, data]);
        data = EMPTY;
      }
      const head = parseFrameHeader(this.buf);
      if (head === null) return;
      if (head === "error") {
        this.close(1002, "protocol error");
        return;
      }
      if (head.payloadLen > MAX_MESSAGE_BYTES || this.fragmentBytes + head.payloadLen > MAX_MESSAGE_BYTES) {
        this.close(1009, "message too big");
        return;
      }
      const rest = Buffer.from(this.buf.subarray(head.headerLen));
      this.buf = EMPTY;
      this.frame = head;
      this.payload = Buffer.allocUnsafe(head.payloadLen);
      this.filled = 0;
      this.reading = "payload";
      data = rest;
    }
  }

  private completeFrame(): void {
    const head = this.frame;
    if (!head) return;
    const payload = this.payload;
    this.payload = EMPTY;
    this.frame = null;
    if (head.mask) unmask(payload, head.mask);

    switch (head.opcode) {
      case OP_PING:
        if (this.state === WS_OPEN) {
          try {
            this.socket.write(encodeFrame(OP_PONG, payload));
          } catch {
            // 送れなくても続ける
          }
        }
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.closeCode = code;
        this.close(code === 1005 ? 1000 : code, "");
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragments.length > 0) {
          this.close(1002, "protocol error");
          return;
        }
        this.fragmentOpcode = head.opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        break;
      case OP_CONTINUATION:
        if (this.fragments.length === 0) {
          this.close(1002, "protocol error");
          return;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        break;
      default:
        this.close(1002, "protocol error");
        return;
    }

    if (!head.fin) return;
    const full = this.fragments.length === 1 ? (this.fragments[0] as Buffer) : Buffer.concat(this.fragments);
    const opcode = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentBytes = 0;
    // mxrelay.v1 はテキストだけを使う。バイナリは無視する
    if (opcode !== OP_TEXT || !this.onmessage) return;
    try {
      this.onmessage(full.toString("utf8"));
    } catch {
      // ハンドラの失敗で接続を落とさない
    }
  }

  private finish(code: number): void {
    if (this.state === WS_CLOSED) return;
    this.state = WS_CLOSED;
    this.buf = EMPTY;
    this.payload = EMPTY;
    this.fragments = [];
    try {
      // 直前に書いた close フレームを流し切ってから閉じる（destroy は取りこぼす）
      this.socket.end();
    } catch {
      // 既に切れている
    }
    // 相手が FIN を返さないときの保険
    const timer = setTimeout(() => {
      try {
        this.socket.destroy();
      } catch {
        // 既に切れている
      }
    }, DESTROY_GRACE_MS);
    timer.unref?.();
    const cb = this.onclose;
    this.onclose = null;
    this.onmessage = null;
    if (cb) {
      try {
        cb(code);
      } catch {
        // 片付けの失敗は無視する
      }
    }
  }
}

export interface AcceptOptions {
  /** 受け付けるサブプロトコル（要求に含まれていれば返す） */
  subprotocol?: string;
  connId?: string;
}

/**
 * Upgrade 要求を受け付けて WebSocket にする。握手できなければソケットを閉じて null を返す。
 * 呼び出し側は先に Host・Origin・接続元を検査しておくこと。
 */
export function acceptWebSocket(req: IncomingMessage, socket: UpgradeSocket, head: Buffer, opts: AcceptOptions = {}): BridgeSocket | null {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  if (typeof key !== "string" || key.length === 0 || String(version) !== "13") {
    writeRaw(socket, "HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n");
    try {
      socket.destroy();
    } catch {
      // 既に切れている
    }
    return null;
  }
  const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${computeAccept(key)}`];
  const wanted = requestedProtocols(req.headers["sec-websocket-protocol"]);
  if (opts.subprotocol && wanted.includes(opts.subprotocol)) lines.push(`Sec-WebSocket-Protocol: ${opts.subprotocol}`);
  socket.setNoDelay?.(true);
  socket.setTimeout?.(0);
  writeRaw(socket, `${lines.join("\r\n")}\r\n\r\n`);
  // 握手と同じ塊で届いた最初のフレームを読み直せるように戻す
  if (head && head.length > 0) socket.unshift(head);
  return new ServerSocket(socket, opts.connId ?? randomUUID());
}

function writeRaw(socket: UpgradeSocket, text: string): void {
  try {
    socket.write(text);
  } catch {
    // 既に切れている
  }
}
