// ライセンスキー（src/shared/license.ts）と、その保存・確かめ・本番の環境の割り当て（src/bridge/license.ts）、
// 作業画面から使う入口（/_mxstage/license）。鍵は試験のたびに作る（本物の秘密鍵は使わない）。

import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LICENSE_ENVS_FILE, LICENSE_FILE, LicenseStore, licenseTestKeysAllowed } from "../../src/bridge/license.ts";
import { LICENSE_AUTHORIZE_PATH, LICENSE_BODY_LIMIT, LICENSE_PATH } from "../../src/bridge/server.ts";
import { base64UrlDecode, base64UrlEncode, encodeLicenseKey, parseLicenseKey } from "../../src/shared/license.ts";
import type { LicensePayload } from "../../src/shared/license.ts";
import { LICENSE_PUBLIC_KEYS } from "../../src/shared/licenseKeys.ts";
import type { LicensePublicKey } from "../../src/shared/licenseKeys.ts";
import { rawRequest, startTestBridge, stopAll } from "./support.ts";

const NOW = Date.UTC(2026, 9, 1); // 2026-10-01
const SEC = Math.floor(NOW / 1000);
const YEAR = 365 * 24 * 3600;

function keyPair(): { privateKey: KeyObject; x: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, x: publicKey.export({ format: "jwk" }).x as string };
}

const prod = keyPair();
const test = keyPair();
const other = keyPair();
const KEYS: Record<string, LicensePublicKey> = { p1: { x: prod.x, test: false }, s1: { x: test.x, test: true } };

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return { v: 1, kid: "p1", lic: "lic_abc123", org: "ACME Corp", email: "buyer@acme.example", envs: 2, iat: SEC - 3600, exp: SEC + YEAR, ...over };
}

function issue(p: LicensePayload, privateKey = p.kid === "s1" ? test.privateKey : prod.privateKey): Promise<string> {
  return encodeLicenseKey(p, (input) => new Uint8Array(sign(null, input, privateKey)));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mxs-license-"));
});

afterEach(async () => {
  await stopAll();
  rmSync(dir, { recursive: true, force: true });
});

function store(opts: { allowTestKeys?: boolean; revoked?: ReadonlySet<string>; now?: () => number } = {}): LicenseStore {
  return new LicenseStore({ dir, keys: KEYS, now: opts.now ?? (() => NOW), allowTestKeys: opts.allowTestKeys ?? false, revoked: opts.revoked ?? new Set() });
}

describe("キーの形（src/shared/license.ts）", () => {
  it("base64url は往復でき、決まりに合わない書き方は受けない", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const text = base64UrlEncode(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(base64UrlDecode(text)).toEqual(bytes);
      }),
    );
    expect(base64UrlDecode("ab+/")).toBeNull();
    expect(base64UrlDecode("abcd=")).toBeNull();
    expect(base64UrlDecode("a")).toBeNull();
    expect(base64UrlDecode("QR")).toBeNull(); // 余りのビットが 0 でない（"QQ" と同じバイト列の別の書き方）
    expect(base64UrlDecode("QQ")).toEqual(Uint8Array.from([0x41]));
  });

  it("貼り付けで入った改行・空白・ゼロ幅の文字を無視して読む", async () => {
    const key = await issue(payload());
    const messy = `  ${key.slice(0, 40)}\r\n${key.slice(40, 90)}​ \t${key.slice(90)}\n`;
    const parsed = parseLicenseKey(messy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.key).toBe(key);
      expect(parsed.payload.org).toBe("ACME Corp");
    }
  });

  it("形が違う・中身が決まりに合わないキーは読まない", async () => {
    const key = await issue(payload());
    const [, body, sig] = key.split(".");
    expect(parseLicenseKey("")).toEqual({ ok: false, problem: "empty" });
    expect(parseLicenseKey("x".repeat(5000))).toEqual({ ok: false, problem: "too_long" });
    expect(parseLicenseKey(`MXS2.${body}.${sig}`)).toEqual({ ok: false, problem: "format" });
    expect(parseLicenseKey(`MXS1.${body}`)).toEqual({ ok: false, problem: "format" });
    expect(parseLicenseKey(`MXS1.${body}.${sig}.x`)).toEqual({ ok: false, problem: "format" });
    expect(parseLicenseKey(`MXS1.${body}.${sig!.slice(0, 20)}`)).toEqual({ ok: false, problem: "format" });
    const junk = base64UrlEncode(new TextEncoder().encode("not json"));
    expect(parseLicenseKey(`MXS1.${junk}.${sig}`)).toEqual({ ok: false, problem: "payload" });
    for (const bad of [{ envs: 0 }, { envs: 1.5 }, { exp: SEC - 7200 }, { lic: "has space" }, { org: "" }, { kid: "P1!" }, { v: 2 }]) {
      const text = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...payload(), ...bad })));
      expect(parseLicenseKey(`MXS1.${text}.${sig}`), JSON.stringify(bad)).toEqual({ ok: false, problem: "payload" });
    }
    await expect(issue({ ...payload(), envs: 0 })).rejects.toThrow();
  });

  it("製品に入れる公開鍵は本番用（p1）と決済の試験用（s1）で、どちらも 32 バイト", () => {
    expect(Object.keys(LICENSE_PUBLIC_KEYS).sort()).toEqual(["p1", "s1"]);
    expect(LICENSE_PUBLIC_KEYS.p1!.test).toBe(false);
    expect(LICENSE_PUBLIC_KEYS.s1!.test).toBe(true);
    for (const k of Object.values(LICENSE_PUBLIC_KEYS)) expect(base64UrlDecode(k.x)?.length).toBe(32);
  });
});

describe("キーの保存と確かめ（LicenseStore）", () => {
  it("正しいキーを保存し、状態に組織名・環境の数・期限を返す（キーとメールは返さない）", async () => {
    const s = store();
    expect(s.status()).toEqual({ state: "none" });
    const key = await issue(payload());
    const saved = s.save(`\n${key}\n`);
    expect(saved.ok).toBe(true);
    expect(readFileSync(join(dir, LICENSE_FILE), "utf8")).toBe(`${key}\n`);
    const status = s.status();
    expect(status).toMatchObject({ state: "valid", licenseId: "lic_abc123", org: "ACME Corp", envsLicensed: 2, envsInUse: 0, boundScopes: [] });
    expect(status.expiresAt).toBe(new Date((SEC + YEAR) * 1000).toISOString());
    expect(JSON.stringify(status)).not.toContain("buyer@acme.example");
    expect(JSON.stringify(status)).not.toContain(key.split(".")[2]);
    expect(status.test).toBeUndefined();
  });

  it("書き換えたキー・知らない鍵・別の鍵で署名したキーは受け付けず、保存してある正しいキーを上書きしない", async () => {
    const s = store();
    const good = await issue(payload());
    expect(s.save(good).ok).toBe(true);

    const [, body, sig] = good.split(".");
    const forged = JSON.parse(new TextDecoder().decode(base64UrlDecode(body!)!)) as LicensePayload;
    forged.envs = 50;
    const tampered = `MXS1.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(forged)))}.${sig}`;
    expect(s.save(tampered)).toMatchObject({ ok: false, problem: "signature" });
    expect(s.save(await issue(payload({ kid: "p9" }), other.privateKey))).toMatchObject({ ok: false, problem: "unknown_key" });
    expect(s.save(await issue(payload(), other.privateKey))).toMatchObject({ ok: false, problem: "signature" });
    expect(s.save("MXS1.garbage")).toMatchObject({ ok: false, problem: "format" });

    expect(readFileSync(join(dir, LICENSE_FILE), "utf8")).toBe(`${good}\n`);
    expect(s.status()).toMatchObject({ state: "valid", envsLicensed: 2 });
  });

  it("期限切れ・取り消したキーは保存しない。保存したキーも、期限を過ぎれば expired・取り消せば revoked になる", async () => {
    expect(store().save(await issue(payload({ iat: SEC - 2 * YEAR, exp: SEC - 1 })))).toMatchObject({ ok: false, problem: "expired" });
    expect(store({ revoked: new Set(["lic_abc123"]) }).save(await issue(payload()))).toMatchObject({ ok: false, problem: "revoked" });
    expect(existsSync(join(dir, LICENSE_FILE))).toBe(false);

    expect(store().save(await issue(payload({ exp: SEC + 60 }))).ok).toBe(true);
    expect(store({ now: () => NOW + 61_000 }).status().state).toBe("expired");
    expect(store({ revoked: new Set(["lic_abc123"]) }).status().state).toBe("revoked");
    writeFileSync(join(dir, LICENSE_FILE), "壊れた中身", "utf8");
    expect(store().status()).toEqual({ state: "invalid", problem: "format" });
  });

  it("決済の試験用の鍵（s1）で署名したキーは、試験の設定（MXSTAGE_LICENSE_TEST=1）のときだけ受け付ける", async () => {
    const key = await issue(payload({ kid: "s1" }));
    expect(store().save(key)).toMatchObject({ ok: false, problem: "test_key" });
    const saved = store({ allowTestKeys: true }).save(key);
    expect(saved.ok).toBe(true);
    expect(saved.status.test).toBe(true);
    expect(store().status()).toEqual({ state: "invalid", problem: "test_key" });
    expect(licenseTestKeysAllowed({ MXSTAGE_LICENSE_TEST: "1" })).toBe(true);
    expect(licenseTestKeysAllowed({ MXSTAGE_LICENSE_TEST: "true" })).toBe(false);
    expect(licenseTestKeysAllowed({})).toBe(false);
  });
});

describe("本番の環境の割り当て（authorize）", () => {
  it("ライセンスが無い・期限切れなら断る", async () => {
    expect(store().authorize("https://maximo.acme.example/maximo")).toMatchObject({ ok: false, problem: "no_license" });
    store().save(await issue(payload({ exp: SEC + 60 })));
    expect(store({ now: () => NOW + 61_000 }).authorize("https://maximo.acme.example/maximo")).toMatchObject({ ok: false, problem: "expired" });
    writeFileSync(join(dir, LICENSE_FILE), "壊れた中身", "utf8");
    expect(store().authorize("https://maximo.acme.example/maximo")).toMatchObject({ ok: false, problem: "invalid" });
  });

  it("環境の数まで結びつけ、同じ接続先（書き方の違いを含む）は数えない。数を超えたら断る", async () => {
    const s = store();
    s.save(await issue(payload({ envs: 2 })));
    const first = s.authorize("https://MAXIMO.acme.example/maximo/");
    expect(first).toMatchObject({ ok: true, scope: "https://maximo.acme.example/maximo", newlyBound: true });
    expect(s.authorize(" https://maximo.acme.example/maximo ")).toMatchObject({ ok: true, newlyBound: false });
    expect(s.authorize("https://prod2.acme.example/maximo")).toMatchObject({ ok: true, newlyBound: true });
    const third = s.authorize("https://prod3.acme.example/maximo");
    expect(third).toMatchObject({ ok: false, problem: "envs_exceeded" });
    expect(third.status).toMatchObject({ envsLicensed: 2, envsInUse: 2, boundScopes: ["https://maximo.acme.example/maximo", "https://prod2.acme.example/maximo"] });
    expect(s.authorize("maximo の本番")).toMatchObject({ ok: false, problem: "bad_scope" });
  });

  it("更新したキー（同じライセンス ID）では結びつけた環境を引き継ぎ、別のライセンスでは数え直す", async () => {
    const s = store();
    s.save(await issue(payload({ envs: 1 })));
    expect(s.authorize("https://maximo.acme.example/maximo").ok).toBe(true);
    s.save(await issue(payload({ envs: 1, iat: SEC, exp: SEC + 2 * YEAR })));
    expect(s.status()).toMatchObject({ envsInUse: 1, boundScopes: ["https://maximo.acme.example/maximo"] });
    expect(s.authorize("https://prod2.acme.example/maximo")).toMatchObject({ ok: false, problem: "envs_exceeded" });

    s.save(await issue(payload({ lic: "lic_new", envs: 1 })));
    expect(s.status()).toMatchObject({ licenseId: "lic_new", envsInUse: 0 });
    expect(s.authorize("https://prod2.acme.example/maximo").ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, LICENSE_ENVS_FILE), "utf8"))).toMatchObject({ version: 1, licenseId: "lic_new", scopes: [{ scope: "https://prod2.acme.example/maximo" }] });
  });
});

describe("作業画面から使う入口（/_mxstage/license）", () => {
  const sameOrigin = (port: number) => ({ origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });

  it("状態を返し、正しいキーだけを保存し、本番の環境を結びつける", async () => {
    const bridge = await startTestBridge({ license: store() });
    const first = await rawRequest(bridge, LICENSE_PATH);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true, license: { state: "none" } });
    expect(first.headers["cache-control"]).toBe("no-store");

    const rejected = await rawRequest(bridge, LICENSE_PATH, { method: "POST", headers: sameOrigin(bridge.port), body: JSON.stringify({ key: "MXS1.x.y" }) });
    expect(rejected.status).toBe(422);
    expect(JSON.parse(rejected.body)).toMatchObject({ ok: false, error: "license_rejected", problem: "format" });

    const key = await issue(payload({ envs: 1 }));
    const saved = await rawRequest(bridge, LICENSE_PATH, { method: "POST", headers: sameOrigin(bridge.port), body: JSON.stringify({ key }) });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ ok: true, license: { state: "valid", org: "ACME Corp" } });
    expect(saved.body).not.toContain("buyer@acme.example");
    expect(saved.body).not.toContain(key.split(".")[2]);

    const auth = (baseUrl: string) => rawRequest(bridge, LICENSE_AUTHORIZE_PATH, { method: "POST", headers: sameOrigin(bridge.port), body: JSON.stringify({ baseUrl }) });
    const bound = await auth("https://maximo.acme.example/maximo");
    expect(bound.status).toBe(200);
    expect(JSON.parse(bound.body)).toMatchObject({ ok: true, scope: "https://maximo.acme.example/maximo", newlyBound: true, license: { envsInUse: 1 } });
    const exceeded = await auth("https://prod2.acme.example/maximo");
    expect(exceeded.status).toBe(403);
    expect(JSON.parse(exceeded.body)).toMatchObject({ ok: false, error: "license_required", problem: "envs_exceeded" });
  });

  it("同一オリジン以外（Origin の無い POST・別のオリジン）は受けない。大きすぎる本文・壊れた本文・違うメソッドも断る", async () => {
    const bridge = await startTestBridge({ license: store() });
    const key = await issue(payload());
    const noOrigin = await rawRequest(bridge, LICENSE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    expect(noOrigin.status).toBe(403);
    const foreign = await rawRequest(bridge, LICENSE_AUTHORIZE_PATH, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://x.example" }) });
    expect(foreign.status).toBe(403);
    const crossSite = await rawRequest(bridge, LICENSE_PATH, { method: "POST", headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify({ key }) });
    expect(crossSite.status).toBe(403);
    expect(existsSync(join(dir, LICENSE_FILE))).toBe(false);

    const big = await rawRequest(bridge, LICENSE_PATH, { method: "POST", headers: sameOrigin(bridge.port), body: JSON.stringify({ key: "x".repeat(LICENSE_BODY_LIMIT) }) });
    expect(big.status).toBe(413);
    const broken = await rawRequest(bridge, LICENSE_PATH, { method: "POST", headers: sameOrigin(bridge.port), body: "{not json" });
    expect(broken.status).toBe(400);
    const noScope = await rawRequest(bridge, LICENSE_AUTHORIZE_PATH, { method: "POST", headers: sameOrigin(bridge.port), body: "{}" });
    expect(noScope.status).toBe(400);
    const put = await rawRequest(bridge, LICENSE_PATH, { method: "PUT", headers: sameOrigin(bridge.port), body: "{}" });
    expect(put.status).toBe(405);
    const getAuth = await rawRequest(bridge, LICENSE_AUTHORIZE_PATH);
    expect(getAuth.status).toBe(405);
  });

  it("ライセンスを扱えない橋渡しは 503 を返す（本番への反映はできない）", async () => {
    const bridge = await startTestBridge();
    const res = await rawRequest(bridge, LICENSE_PATH);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "license_unavailable" });
  });
});
