// xlsx（ZIP）の中身を取り出す。依存を足さず、展開はブラウザの DecompressionStream（deflate-raw）に任せる。
// - 中央ディレクトリから項目を読む（ZIP64 の拡張にも対応。xlsx を書く道具によっては小さなファイルでも使う）。
// - 暗号化された項目・stored / deflate 以外の圧縮は読まない。
// - 展開後の大きさに上限を設け、圧縮率の極端なファイル（zip bomb）で画面を固めない。

export interface ZipEntry {
  name: string;
  /** 0 = stored、8 = deflate */
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 符号なし 64 ビット（2^53 を超える値は扱わない） */
function u64(dv: DataView, at: number): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  if (hi >= 0x200000) throw new ZipError("A ZIP size value is too large");
  return hi * 0x100000000 + lo;
}

function findEndOfCentralDirectory(dv: DataView): number {
  const min = Math.max(0, dv.byteLength - 22 - U16_MAX);
  for (let at = dv.byteLength - 22; at >= min; at--) {
    if (dv.getUint32(at, true) === EOCD_SIG) return at;
  }
  throw new ZipError("The ZIP directory was not found (the file is damaged or not a ZIP file)");
}

/** 中央ディレクトリを読み、名前 → 項目の表を返す */
export function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const dv = view(bytes);
  if (dv.byteLength < 22) throw new ZipError("Too short to be a ZIP file");
  const eocd = findEndOfCentralDirectory(dv);
  let count = dv.getUint16(eocd + 10, true);
  let dirSize = dv.getUint32(eocd + 12, true);
  let dirOffset = dv.getUint32(eocd + 16, true);
  if (count === U16_MAX || dirSize === U32_MAX || dirOffset === U32_MAX) {
    const locator = eocd - 20;
    if (locator < 0 || dv.getUint32(locator, true) !== ZIP64_LOCATOR_SIG) throw new ZipError("The ZIP64 directory was not found");
    const at = u64(dv, locator + 8);
    if (at + 56 > dv.byteLength || dv.getUint32(at, true) !== ZIP64_EOCD_SIG) throw new ZipError("The ZIP64 directory is damaged");
    count = u64(dv, at + 32);
    dirSize = u64(dv, at + 40);
    dirOffset = u64(dv, at + 48);
  }
  if (dirOffset + dirSize > dv.byteLength) throw new ZipError("The ZIP directory points outside the file");

  const decoder = new TextDecoder("utf-8");
  const entries = new Map<string, ZipEntry>();
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== CENTRAL_SIG) throw new ZipError("The ZIP directory is damaged");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOffset = dv.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 の拡張（0x0001）: 32 ビットに収まらない値だけが、この順で入る
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = dv.getUint16(e, true);
      const len = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        const end = e + 4 + len;
        if (size === U32_MAX && q + 8 <= end) {
          size = u64(dv, q);
          q += 8;
        }
        if (compressedSize === U32_MAX && q + 8 <= end) {
          compressedSize = u64(dv, q);
          q += 8;
        }
        if (localOffset === U32_MAX && q + 8 <= end) localOffset = u64(dv, q);
      }
      e += 4 + len;
    }
    entries.set(name, { name, method, flags, compressedSize, size, localOffset });
    p = extraEnd + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // 書き込み側の失敗は読み取り側にも伝わるので、ここでは握りつぶす（未処理の Promise にしない）
  writer.write(data as Uint8Array<ArrayBuffer>).then(
    () => writer.close().catch(() => undefined),
    () => undefined,
  );
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ZipError(`Not read because it would exceed ${Math.round(maxBytes / 1024 / 1024)} MB when extracted`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError("Cannot extract the ZIP contents (the file is damaged)");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** 項目 1 つを取り出す。maxBytes は展開後の上限 */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  if ((entry.flags & 0x1) !== 0) throw new ZipError("Encrypted files cannot be read");
  if (entry.size > maxBytes) throw new ZipError(`Not read because it would exceed ${Math.round(maxBytes / 1024 / 1024)} MB when extracted`);
  const dv = view(bytes);
  const at = entry.localOffset;
  if (at + 30 > dv.byteLength || dv.getUint32(at, true) !== LOCAL_SIG) throw new ZipError(`The ZIP entry ${entry.name} is damaged`);
  const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > dv.byteLength) throw new ZipError(`The ZIP entry ${entry.name} points outside the file`);
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data, maxBytes);
  throw new ZipError(`The ZIP compression method ${entry.method} is not supported`);
}
