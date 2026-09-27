// import.chunk の組み立て（ImportAssembler）の試験。
// 断片は橋渡し（src/bridge/importUpload.ts）と同じく、生バイトで固定長に切って base64 にする。
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPORT_IDLE_MS, IMPORT_MAX_BYTES, IMPORT_MAX_CONCURRENT, ImportAssembler, parseImportChunk } from "../../src/app/relay/imports";
import type { ImportAssemblerOptions, ImportErrorReason, ImportedFile } from "../../src/app/relay/imports";
import type { ImportChunkMsg } from "../../src/shared/protocol";

const CHUNK_BYTES = 512 * 1024;

afterEach(() => {
  vi.useRealTimers();
});

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65_536)));
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Worker と同じ切り方（満杯の断片の後ろに続きがあるときだけ送り、最後に last:true） */
function chunksOf(importId: string, data: Uint8Array, size = CHUNK_BYTES, over: Partial<ImportChunkMsg> = {}): ImportChunkMsg[] {
  const out: ImportChunkMsg[] = [];
  let seq = 0;
  for (let offset = 0; offset < data.byteLength || seq === 0; offset += size) {
    const part = data.subarray(offset, Math.min(data.byteLength, offset + size));
    const last = offset + size >= data.byteLength;
    out.push({
      type: "import.chunk",
      importId,
      seq,
      data: toBase64(part),
      last,
      fileName: "spec.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      totalBytes: data.byteLength,
      ...over,
    });
    seq += 1;
    if (last) break;
  }
  return out;
}

function harness(opts: ImportAssemblerOptions = {}) {
  const errors: Array<[string, ImportErrorReason]> = [];
  const files: ImportedFile[] = [];
  let notify: (f: ImportedFile) => void = () => undefined;
  const nextFile = new Promise<ImportedFile>((resolve) => {
    notify = resolve;
  });
  const assembler = new ImportAssembler({
    onImport: (f) => {
      files.push(f);
      notify(f);
    },
    onImportError: (id, reason) => errors.push([id, reason]),
    ...opts,
  });
  return { assembler, errors, files, nextFile };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("ImportAssembler", () => {
  it("連続した断片を連結し、bytes と sha256 を onImport に渡す", async () => {
    const { assembler, errors, nextFile } = harness();
    const data = randomBytes(CHUNK_BYTES * 2 + 12_345);
    const chunks = chunksOf("imp-ok", data);
    expect(chunks.map((c) => [c.seq, c.last])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
    for (const c of chunks) assembler.push(c);
    expect(assembler.activeCount).toBe(0);

    const file = await nextFile;
    expect(errors).toEqual([]);
    expect(file.importId).toBe("imp-ok");
    expect(file.fileName).toBe("spec.xlsx");
    expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(file.bytes.byteLength).toBe(data.byteLength);
    expect(file.bytes).toEqual(data);
    expect(file.sha256).toBe(hex(await crypto.subtle.digest("SHA-256", data)));
  });

  it("sha256 は小文字 16 進（既知の値）。0 バイトのファイルも受け取れる", async () => {
    const abc = harness();
    abc.assembler.push(chunksOf("imp-abc", new TextEncoder().encode("abc"))[0] as ImportChunkMsg);
    expect((await abc.nextFile).sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    const empty = harness();
    empty.assembler.push(chunksOf("imp-empty", new Uint8Array(0))[0] as ImportChunkMsg);
    const file = await empty.nextFile;
    expect(file.bytes.byteLength).toBe(0);
    expect(file.sha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("欠番は破棄して onImportError。残りの断片は黙って捨てる", async () => {
    const { assembler, errors, files } = harness();
    const chunks = chunksOf("imp-gap", randomBytes(CHUNK_BYTES * 3 + 1));
    assembler.push(chunks[0] as ImportChunkMsg);
    assembler.push(chunks[2] as ImportChunkMsg);
    expect(errors).toEqual([["imp-gap", "sequence"]]);
    expect(assembler.activeCount).toBe(0);
    assembler.push(chunks[3] as ImportChunkMsg);
    expect(errors).toHaveLength(1);
    await settle();
    expect(files).toHaveLength(0);
  });

  it("重複・seq 0 以外からの開始も sequence で破棄する", () => {
    const { assembler, errors } = harness();
    const dup = chunksOf("imp-dup", randomBytes(CHUNK_BYTES + 10));
    assembler.push(dup[0] as ImportChunkMsg);
    assembler.push(dup[0] as ImportChunkMsg);
    const late = chunksOf("imp-late", randomBytes(CHUNK_BYTES + 10));
    assembler.push(late[1] as ImportChunkMsg);
    expect(errors).toEqual([
      ["imp-dup", "sequence"],
      ["imp-late", "sequence"],
    ]);
  });

  it("合計が totalBytes と合わなければ size_mismatch", async () => {
    const { assembler, errors, files } = harness();
    const data = randomBytes(CHUNK_BYTES + 100);
    // 宣言より少ない
    for (const c of chunksOf("imp-short", data, CHUNK_BYTES, { totalBytes: data.byteLength + 1 })) assembler.push(c);
    // 宣言より多い
    assembler.push(chunksOf("imp-long", randomBytes(20), CHUNK_BYTES, { totalBytes: 10 })[0] as ImportChunkMsg);
    // 途中で totalBytes が変わる
    const changing = chunksOf("imp-change", data);
    assembler.push(changing[0] as ImportChunkMsg);
    assembler.push({ ...(changing[1] as ImportChunkMsg), totalBytes: data.byteLength + 5 });
    expect(errors).toEqual([
      ["imp-short", "size_mismatch"],
      ["imp-long", "size_mismatch"],
      ["imp-change", "size_mismatch"],
    ]);
    await settle();
    expect(files).toHaveLength(0);
  });

  it("上限（20MB）を超える totalBytes は受け取らず too_large", () => {
    const { assembler, errors } = harness();
    assembler.push(chunksOf("imp-big", randomBytes(10), CHUNK_BYTES, { totalBytes: IMPORT_MAX_BYTES + 1, last: false })[0] as ImportChunkMsg);
    expect(errors).toEqual([["imp-big", "too_large"]]);
    expect(assembler.activeCount).toBe(0);
  });

  it("受け取った量が上限を超えたら too_large、上限ちょうどは受け取る", async () => {
    const limited = harness({ maxBytes: 1_000 });
    const over = randomBytes(1_200);
    for (const c of chunksOf("imp-over", over, 600, { totalBytes: 1_000 })) limited.assembler.push(c);
    expect(limited.errors).toEqual([["imp-over", "too_large"]]);

    const exact = harness({ maxBytes: 1_000 });
    const data = randomBytes(1_000);
    for (const c of chunksOf("imp-exact", data, 600)) exact.assembler.push(c);
    expect((await exact.nextFile).bytes).toEqual(data);
    expect(exact.errors).toEqual([]);
  });

  it("5 分間続きが来なければ破棄する（続きが来るたびに待ち直す）", () => {
    vi.useFakeTimers();
    const { assembler, errors } = harness();
    const chunks = chunksOf("imp-idle", randomBytes(CHUNK_BYTES * 3));
    assembler.push(chunks[0] as ImportChunkMsg);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(IMPORT_IDLE_MS - 1);
    assembler.push(chunks[1] as ImportChunkMsg);
    vi.advanceTimersByTime(IMPORT_IDLE_MS - 1);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(errors).toEqual([["imp-idle", "timeout"]]);
    expect(assembler.activeCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    assembler.push(chunks[2] as ImportChunkMsg);
    expect(errors).toHaveLength(1);
  });

  it("同時に扱うのは 3 件まで", () => {
    const { assembler, errors } = harness();
    for (let i = 0; i < IMPORT_MAX_CONCURRENT; i++) {
      assembler.push(chunksOf(`imp-${i}`, randomBytes(CHUNK_BYTES + 1))[0] as ImportChunkMsg);
    }
    expect(assembler.activeCount).toBe(IMPORT_MAX_CONCURRENT);
    assembler.push(chunksOf("imp-extra", randomBytes(CHUNK_BYTES + 1))[0] as ImportChunkMsg);
    expect(errors).toEqual([["imp-extra", "too_many"]]);
    expect(assembler.activeCount).toBe(IMPORT_MAX_CONCURRENT);
  });

  it("base64 として読めなければ invalid_data", () => {
    const { assembler, errors } = harness();
    assembler.push({ ...(chunksOf("imp-bad", randomBytes(10))[0] as ImportChunkMsg), data: "@@@ not base64 @@@" });
    expect(errors).toEqual([["imp-bad", "invalid_data"]]);
  });

  it("sha256 を計算できなければ digest_failed", async () => {
    const { assembler, errors, files } = harness({ digest: () => Promise.reject(new Error("no subtle")) });
    assembler.push(chunksOf("imp-digest", randomBytes(10))[0] as ImportChunkMsg);
    await settle();
    expect(errors).toEqual([["imp-digest", "digest_failed"]]);
    expect(files).toHaveLength(0);
  });

  it("dispose() でタイマーと組み立て中のものを捨て、計算中の結果も通知しない", async () => {
    vi.useFakeTimers();
    let release: (buf: ArrayBuffer) => void = () => undefined;
    const { assembler, errors, files } = harness({
      digest: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    });
    assembler.push(chunksOf("imp-a", randomBytes(CHUNK_BYTES + 1))[0] as ImportChunkMsg);
    assembler.push(chunksOf("imp-b", randomBytes(10))[0] as ImportChunkMsg);
    expect(vi.getTimerCount()).toBe(1);

    assembler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(assembler.activeCount).toBe(0);
    release(new ArrayBuffer(32));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(files).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it("parseImportChunk は形の合わないものを null にする", () => {
    const ok = chunksOf("imp-parse", randomBytes(10))[0] as ImportChunkMsg;
    expect(parseImportChunk(ok)).toEqual(ok);
    expect(parseImportChunk(null)).toBeNull();
    expect(parseImportChunk({ ...ok, type: "tool.chunk" })).toBeNull();
    expect(parseImportChunk({ ...ok, importId: "" })).toBeNull();
    expect(parseImportChunk({ ...ok, seq: -1 })).toBeNull();
    expect(parseImportChunk({ ...ok, seq: 1.5 })).toBeNull();
    expect(parseImportChunk({ ...ok, totalBytes: "10" })).toBeNull();
    expect(parseImportChunk({ ...ok, data: 1 })).toBeNull();
    expect(parseImportChunk({ ...ok, last: "true" })).toBeNull();
    const { fileName: _omit, ...noName } = ok;
    expect(parseImportChunk(noName)).toBeNull();
  });
});
