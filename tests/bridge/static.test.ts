// 静的配信（dist/app）と、配信ディレクトリの外へ出られないこと。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeFor, isSpaFallbackPath, isSpaPath, resolveStaticPath } from "../../src/bridge/staticFiles.ts";
import { rawRequest, startTestBridge, stopAll } from "./support.ts";
import type { BridgeServer } from "../../src/bridge/server.ts";

let base = "";
let root = "";
let bridge: BridgeServer;

beforeAll(async () => {
  // 一時フォルダの中に「配信ディレクトリ」と「その外のファイル」を作る（tmpdir の直下は汚さない）
  base = await mkdtemp(join(tmpdir(), "mxs-bridge-"));
  root = join(base, "app");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>MX Stage</title>", "utf8");
  await writeFile(join(root, "assets", "index-abc.js"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "sw.js"), "self.addEventListener('install', () => {});", "utf8");
  await writeFile(join(base, "outside.txt"), "秘密", "utf8");
  // 利用者の Skill（~/.config/mxstage/skills の代わり）
  await mkdir(join(base, "user-skills", "my-flow"), { recursive: true });
  await writeFile(
    join(base, "user-skills", "my-flow", "SKILL.md"),
    '---\nname: my-flow\ndescription: "業務の手順"\nmetadata:\n  version: "0.1.0"\n---\n\n# 業務の手順\n\nget_status から始める。\n',
    "utf8",
  );
  bridge = await startTestBridge({ root, userSkillsDir: join(base, "user-skills") });
});

afterAll(async () => {
  await stopAll();
  if (base) await rm(base, { recursive: true, force: true });
});

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${bridge.origin}${path}`, init);
}

describe("パスの解決", () => {
  it("SPA の入口は index.html", () => {
    expect(isSpaPath("/")).toBe(true);
    expect(isSpaPath("/app")).toBe(true);
    expect(isSpaPath("/app/")).toBe(true);
    expect(isSpaPath("/settings")).toBe(true);
    expect(isSpaPath("/structures")).toBe(true);
    expect(isSpaPath("/assets/x.js")).toBe(false);
  });

  it("拡張子の無い知らないパスだけを画面の受け皿にする", () => {
    expect(isSpaFallbackPath("/tools")).toBe(true);
    expect(isSpaFallbackPath("/app/detail/")).toBe(true);
    // 消えた資材に HTML を返すと、画面が分かりにくい形で壊れる
    expect(isSpaFallbackPath("/assets/index-old")).toBe(false);
    expect(isSpaFallbackPath("/missing.js")).toBe(false);
    expect(isSpaFallbackPath("/favicon.ico")).toBe(false);
  });

  it("配信ディレクトリの外は解決しない", () => {
    const base = resolve("/root");
    // .. を含む指定は外へ出ず、配信ディレクトリの中に畳まれる（畳めないものは null）
    for (const path of ["/../etc/passwd", "/a/../../b", "/../../../../etc/passwd"]) {
      const full = resolveStaticPath("/root", path);
      if (full !== null) expect(full.startsWith(base + sep)).toBe(true);
    }
    expect(resolveStaticPath("/root", "/C:/windows")).toBeNull();
    expect(resolveStaticPath("/root", "/a\\..\\b")).toBeNull();
    expect(resolveStaticPath("/root", "/%00")).toBeNull();
    expect(resolveStaticPath("/root", "/assets/x.js")).not.toBeNull();
  });

  it("拡張子から Content-Type を決める", () => {
    expect(contentTypeFor("a.html")).toContain("text/html");
    expect(contentTypeFor("a.js")).toContain("text/javascript");
    expect(contentTypeFor("a.css")).toContain("text/css");
    // PWA のマニフェスト（ブラウザは application/manifest+json 以外だと警告する）
    expect(contentTypeFor("manifest.webmanifest")).toBe("application/manifest+json");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
  });
});

describe("配信", () => {
  it("/app は index.html を返す", async () => {
    const res = await get("/app");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("MX Stage");
  });

  it("他のサイトに埋め込ませない", async () => {
    const res = await get("/app");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Fetch Metadata に対応したブラウザでは、別のサイトの iframe からの読み込み自体を入口で止める
    const framed = await rawRequest(bridge, "/app", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" } });
    expect(framed.status).toBe(403);
  });

  it("/settings と知らないパスも画面を返す（SPA）", async () => {
    expect((await get("/settings")).status).toBe(200);
    expect((await get("/")).status).toBe(200);
    // 知らないパスは画面が /app へ寄せる（src/app/ui/routes.ts）ので index.html を返す
    const unknown = await get("/tools/list");
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get("content-type")).toContain("text/html");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.text()).toContain("MX Stage");
  });

  it("無い資材は index.html で代用せず 404", async () => {
    for (const path of ["/assets/index-old.js", "/missing.css", "/assets/index-old"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("資材はハッシュ付きなので長くキャッシュさせる", async () => {
    const res = await get("/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("名前が変わらないファイルはキャッシュさせない", async () => {
    // service worker（/sw.js）を 1 年キャッシュすると更新が届かなくなる
    const res = await get("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("上のフォルダのファイルは読めない", async () => {
    for (const path of ["/../outside.txt", "/assets/../../outside.txt", "/%2e%2e/outside.txt"]) {
      const res = await get(path);
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) expect(await res.text()).not.toContain("秘密");
    }
  });

  it("Skill の一覧はアプリ既定と利用者の Skill を分けて返す（本文は返さない）", async () => {
    const res = await get("/_mxstage/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; origin: string; body?: string }>; problems: unknown[]; userSkillsDir: string };
    expect(body.skills.find((s) => s.name === "mxstage-workbench")?.origin).toBe("default");
    expect(body.skills.find((s) => s.name === "my-flow")?.origin).toBe("user");
    expect(body.skills.every((s) => s.body === undefined)).toBe(true);
    expect(body.problems).toEqual([]);
    expect(body.userSkillsDir).toBe(join(base, "user-skills"));
  });

  it("Skill の ZIP は配らない（/skills/ は画面の資材でもない）", async () => {
    for (const path of ["/skills/mxstage-workbench.zip", "/skills/index.json", "/skills/../outside.txt"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("秘密");
    }
  });

  it("Host が違えば 403", async () => {
    const res = await rawRequest(bridge, "/app", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "forbidden_host" });
  });

  it("別のサイトからの POST は 403", async () => {
    const res = await rawRequest(bridge, "/app", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "forbidden_origin" });
  });
});
