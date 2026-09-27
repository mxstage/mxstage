// /import/:importId のアップロード。橋渡しは保存せず、断片を作業タブへ流すだけ。

import { afterEach, describe, expect, it } from "vitest";
import { ImportTickets, IMPORT_CHUNK_BYTES, sanitizeFileName } from "../../src/bridge/importUpload.ts";
import { runWorkerTool } from "../../src/bridge/mcp.ts";
import { FakeTab, rawRequest, startTestBridge, stopAll, waitFor } from "./support.ts";

afterEach(async () => {
  await stopAll();
});

describe("ファイル名の後始末", () => {
  it("パス区切りと制御文字を落とす", () => {
    expect(sanitizeFileName("a%00b%1Fc%7Fd.xlsx")).toBe("abcd.xlsx");
    expect(sanitizeFileName("C:\\work\\台帳.xlsx")).toBe("台帳.xlsx");
    expect(sanitizeFileName("/etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("%E5%8F%B0%E5%B8%B3.xlsx")).toBe("台帳.xlsx");
    expect(sanitizeFileName(undefined)).toBe("upload.xlsx");
  });
});

describe("チケット", () => {
  it("1 回だけ使える", () => {
    const tickets = new ImportTickets();
    const t = tickets.create();
    expect(tickets.take(t.importId)).toMatchObject({ importId: t.importId });
    expect(tickets.take(t.importId)).toBeNull();
  });

  it("期限が切れていれば expired", () => {
    let now = 1_000;
    const tickets = new ImportTickets(() => now);
    const t = tickets.create();
    now += 10 * 60_000 + 1;
    expect(tickets.take(t.importId)).toBe("expired");
  });
});

describe("アップロード", () => {
  it("create_import_session が案内する curl の形（Origin も Sec-Fetch-Site も無い POST）で届く", async () => {
    const bridge = await startTestBridge();
    const tab = await FakeTab.connect(bridge);
    const session = await runWorkerTool({ origin: bridge.origin, hub: bridge.hub, tickets: bridge.tickets, version: "test" }, "create_import_session", {
      fileName: "台帳.xlsx",
    });
    const info = session.structuredContent as { uploadUrl: string; curl: string };
    const url = new URL(info.uploadUrl);
    expect(url.origin).toBe(bridge.origin);

    // curl の -H をそのまま使う。curl が自分で足すのは Host と Content-Length だけ
    const headers: Record<string, string> = {};
    for (const m of info.curl.matchAll(/-H "([^:"]+): ([^"]*)"/g)) headers[(m[1] as string).toLowerCase()] = m[2] as string;
    expect(headers).not.toHaveProperty("origin");
    expect(headers).not.toHaveProperty("sec-fetch-site");
    const body = Buffer.from("PK" + String.fromCharCode(3, 4) + " excel");
    const res = await rawRequest(bridge, url.pathname, { method: "POST", headers: { ...headers, "content-length": String(body.length) }, body });
    expect(res.status).toBe(200);
    await waitFor(() => tab.frames("import.chunk").length === 1);
    expect(tab.frames("import.chunk")[0]).toMatchObject({ seq: 0, last: true, fileName: "台帳.xlsx" });
  });

  it("別のサイトのページからの POST は、URL を知っていても受け付けない", async () => {
    const tickets = new ImportTickets();
    const bridge = await startTestBridge({ tickets });
    const tab = await FakeTab.connect(bridge);
    const body = Buffer.from("hello");
    const browserHeaders: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
    for (const extra of browserHeaders) {
      const ticket = tickets.create();
      const res = await rawRequest(bridge, `/import/${ticket.importId}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(body.length), ...extra },
        body,
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: "forbidden_origin" });
    }
    expect(tab.frames("import.chunk")).toHaveLength(0);
  });

  it("タブへ断片を流し、sha256 を返す", async () => {
    const tickets = new ImportTickets();
    const bridge = await startTestBridge({ tickets });
    const tab = await FakeTab.connect(bridge);
    const ticket = tickets.create();
    const body = Buffer.alloc(IMPORT_CHUNK_BYTES + 100, 7);

    const res = await rawRequest(bridge, `/import/${ticket.importId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "%E5%8F%B0%E5%B8%B3.xlsx", "sec-fetch-site": "same-origin", "content-length": String(body.length) },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; bytes: number; sha256: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.bytes).toBe(body.length);
    expect(parsed.sha256).toHaveLength(64);

    await waitFor(() => tab.frames("import.chunk").length === 2);
    const chunks = tab.frames("import.chunk");
    expect(chunks[0]).toMatchObject({ seq: 0, last: false, fileName: "台帳.xlsx", totalBytes: body.length });
    expect(chunks[1]).toMatchObject({ seq: 1, last: true });
    const received = Buffer.concat(chunks.map((c) => Buffer.from(String(c.data), "base64")));
    expect(received.equals(body)).toBe(true);
  });

  it("同じ URL は 2 回使えない", async () => {
    const tickets = new ImportTickets();
    const bridge = await startTestBridge({ tickets });
    await FakeTab.connect(bridge);
    const ticket = tickets.create();
    const body = Buffer.from("hello");
    const headers = { "content-type": "application/octet-stream", "sec-fetch-site": "same-origin", "content-length": String(body.length) };
    expect((await rawRequest(bridge, `/import/${ticket.importId}`, { method: "POST", headers, body })).status).toBe(200);
    const second = await rawRequest(bridge, `/import/${ticket.importId}`, { method: "POST", headers, body });
    expect(second.status).toBe(403);
  });

  it("タブが無ければ 409 で、チケットは残す", async () => {
    const tickets = new ImportTickets();
    const bridge = await startTestBridge({ tickets });
    const ticket = tickets.create();
    const body = Buffer.from("hello");
    const headers = { "content-type": "application/octet-stream", "sec-fetch-site": "same-origin", "content-length": String(body.length) };
    const res = await rawRequest(bridge, `/import/${ticket.importId}`, { method: "POST", headers, body });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "NO_TAB" });
    // タブを開いてから同じ URL でやり直せる
    const tab = await FakeTab.connect(bridge);
    const retry = await rawRequest(bridge, `/import/${ticket.importId}`, { method: "POST", headers, body });
    expect(retry.status).toBe(200);
    await waitFor(() => tab.frames("import.chunk").length === 1);
  });

  it("知らない importId は 403", async () => {
    const bridge = await startTestBridge();
    const res = await rawRequest(bridge, "/import/deadbeef", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-length": "1" },
      body: "x",
    });
    expect(res.status).toBe(403);
  });

  it("GET では受け付けない", async () => {
    const tickets = new ImportTickets();
    const bridge = await startTestBridge({ tickets });
    const ticket = tickets.create();
    const res = await rawRequest(bridge, `/import/${ticket.importId}`);
    expect(res.status).toBe(405);
  });
});
