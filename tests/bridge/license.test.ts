// ライセンスキー（src/shared/license.ts）と、その保存・確かめ・本番への反映の許可（src/bridge/license.ts）、
// 作業画面から使う入口（/_mxstage/license）。鍵は試験のたびに作る（本物の秘密鍵は使わない）。
// 1 ライセンス = 1 本番環境。キーに本番の接続先（別名を 3 つまで）が書いてあり、接続先が合えば何人でも使える。

import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LICENSES_DIR_NAME, LicenseStore, licenseTestKeysAllowed } from "../../src/bridge/license.ts";
import { LICENSE_AUTHORIZE_PATH, LICENSE_BODY_LIMIT, LICENSE_PATH, LICENSE_REMOVE_PATH } from "../../src/bridge/server.ts";
import { base64UrlDecode, base64UrlEncode, encodeLicenseKey, licenseHostOf, parseLicenseKey } from "../../src/shared/license.ts";
import type { LicensePayload } from "../../src/shared/license.ts";
import { LICENSE_PUBLIC_KEYS } from "../../src/shared/licenseKeys.ts";
import type { LicensePublicKey } from "../../src/shared/licenseKeys.ts";
import { rawRequest, startTestBridge, stopAll } from "./support.ts";

const NOW = Date.UTC(2026, 9, 1); // 2026-10-01
const SEC = Math.floor(NOW / 1000);
const YEAR = 365 * 24 * 3600;
const PROD = "https://maximo.acme.example";

function keyPair(): { privateKey: KeyObject; x: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, x: publicKey.export({ format: "jwk" }).x as string };
}

const prod = keyPair();
const test = keyPair();
const other = keyPair();
const KEYS: Record<string, LicensePublicKey> = { p1: { x: prod.x, test: false }, s1: { x: test.x, test: true } };

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return { v: 1, kid: "p1", lic: "lic_abc123", org: "ACME Corp", email: "buyer@acme.example", hosts: [PROD], iat: SEC - 3600, exp: SEC + YEAR, ...over };
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

const keyFiles = () => (existsSync(join(dir, LICENSES_DIR_NAME)) ? readdirSync(join(dir, LICENSES_DIR_NAME)).sort() : []);

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

  it("接続先からホストを取り出す（パスは見ない。http・https 以外と利用者名付きは受けない）", () => {
    expect(licenseHostOf("https://MAXIMO.acme.example/maximo/")).toBe("https://maximo.acme.example");
    expect(licenseHostOf(" https://maximo.acme.example:443/maximo ")).toBe("https://maximo.acme.example");
    expect(licenseHostOf("https://maximo.acme.example:9443")).toBe("https://maximo.acme.example:9443");
    expect(licenseHostOf("http://10.0.0.5/maximo")).toBe("http://10.0.0.5");
    expect(licenseHostOf("ftp://maximo.acme.example")).toBeNull();
    expect(licenseHostOf("https://user:pw@maximo.acme.example")).toBeNull();
    expect(licenseHostOf("maximo の本番")).toBeNull();
  });

  it("貼り付けで入った改行・空白・ゼロ幅の文字を無視して読む", async () => {
    const key = await issue(payload());
    const messy = `  ${key.slice(0, 40)}\r\n${key.slice(40, 90)}​ \t${key.slice(90)}\n`;
    const parsed = parseLicenseKey(messy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.key).toBe(key);
      expect(parsed.payload.hosts).toEqual([PROD]);
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
    const bads: Partial<LicensePayload>[] = [
      { hosts: [] },
      { hosts: [PROD, "https://a.example", "https://b.example", "https://c.example"] }, // 別名は 3 つまで
      { hosts: [PROD, PROD] },
      { hosts: ["https://maximo.acme.example/maximo"] }, // 正規化した形でない
      { hosts: ["https://MAXIMO.acme.example"] },
      { exp: SEC - 7200 },
      { lic: "has space" },
      { org: "" },
      { kid: "P1!" },
    ];
    for (const bad of [...bads, { v: 2 } as unknown as Partial<LicensePayload>]) {
      const text = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...payload(), ...bad })));
      expect(parseLicenseKey(`MXS1.${text}.${sig}`), JSON.stringify(bad)).toEqual({ ok: false, problem: "payload" });
    }
    await expect(issue({ ...payload(), hosts: [] })).rejects.toThrow();
  });

  it("製品に入れる公開鍵は本番用（p1）と決済の試験用（s1）で、どちらも 32 バイト", () => {
    expect(Object.keys(LICENSE_PUBLIC_KEYS).sort()).toEqual(["p1", "s1"]);
    expect(LICENSE_PUBLIC_KEYS.p1!.test).toBe(false);
    expect(LICENSE_PUBLIC_KEYS.s1!.test).toBe(true);
    for (const k of Object.values(LICENSE_PUBLIC_KEYS)) expect(base64UrlDecode(k.x)?.length).toBe(32);
  });
});

describe("キーの保存と確かめ（LicenseStore）", () => {
  it("正しいキーを保存し、組織名・本番の接続先・期限を返す（キーそのものとメールは返さない）", async () => {
    const s = store();
    expect(s.list()).toEqual([]);
    const key = await issue(payload());
    const saved = s.save(`\n${key}\n`);
    expect(saved.ok).toBe(true);
    expect(keyFiles()).toEqual(["lic_abc123.key"]);
    expect(readFileSync(join(dir, LICENSES_DIR_NAME, "lic_abc123.key"), "utf8")).toBe(`${key}\n`);
    const [entry] = s.list();
    expect(entry).toEqual({
      state: "valid",
      licenseId: "lic_abc123",
      org: "ACME Corp",
      hosts: [PROD],
      issuedAt: new Date((SEC - 3600) * 1000).toISOString(),
      expiresAt: new Date((SEC + YEAR) * 1000).toISOString(),
    });
    expect(JSON.stringify(s.list())).not.toContain("buyer@acme.example");
  });

  it("本番環境ごとにキーを置ける。更新したキーは新しいほうで置き換え、古いキーでは置き換えない", async () => {
    const s = store();
    expect(s.save(await issue(payload())).ok).toBe(true);
    expect(s.save(await issue(payload({ lic: "lic_plant2", hosts: ["https://plant2.acme.example"] }))).ok).toBe(true);
    expect(s.list().map((e) => e.licenseId)).toEqual(["lic_abc123", "lic_plant2"]);

    const renewed = await issue(payload({ iat: SEC, exp: SEC + 2 * YEAR }));
    expect(s.save(renewed).ok).toBe(true);
    expect(s.list()[0]!.expiresAt).toBe(new Date((SEC + 2 * YEAR) * 1000).toISOString());
    expect(s.save(await issue(payload({ iat: SEC - 7200 })))).toEqual({ ok: false, problem: "older" });
    expect(s.list()[0]!.expiresAt).toBe(new Date((SEC + 2 * YEAR) * 1000).toISOString());

    expect(s.remove("lic_plant2")).toBe(true);
    expect(s.remove("lic_plant2")).toBe(false);
    expect(s.remove("../x")).toBe(false);
    expect(keyFiles()).toEqual(["lic_abc123.key"]);
  });

  it("書き換えたキー・知らない鍵・別の鍵で署名したキーは受け付けず、保存してある正しいキーを上書きしない", async () => {
    const s = store();
    const good = await issue(payload());
    expect(s.save(good).ok).toBe(true);

    const [, body, sig] = good.split(".");
    const forged = JSON.parse(new TextDecoder().decode(base64UrlDecode(body!)!)) as LicensePayload;
    forged.hosts = ["https://other-company.example"];
    const tampered = `MXS1.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(forged)))}.${sig}`;
    expect(s.save(tampered)).toEqual({ ok: false, problem: "signature" });
    expect(s.save(await issue(payload({ kid: "p9" }), other.privateKey))).toEqual({ ok: false, problem: "unknown_key" });
    expect(s.save(await issue(payload(), other.privateKey))).toEqual({ ok: false, problem: "signature" });
    expect(s.save("MXS1.garbage")).toEqual({ ok: false, problem: "format" });

    expect(readFileSync(join(dir, LICENSES_DIR_NAME, "lic_abc123.key"), "utf8")).toBe(`${good}\n`);
    expect(s.list()).toMatchObject([{ state: "valid", hosts: [PROD] }]);
  });

  it("期限切れ・取り消したキーは保存しない。保存したキーも、期限を過ぎれば expired・取り消せば revoked になる", async () => {
    expect(store().save(await issue(payload({ iat: SEC - 2 * YEAR, exp: SEC - 1 })))).toEqual({ ok: false, problem: "expired" });
    expect(store({ revoked: new Set(["lic_abc123"]) }).save(await issue(payload()))).toEqual({ ok: false, problem: "revoked" });
    expect(keyFiles()).toEqual([]);

    expect(store().save(await issue(payload({ exp: SEC + 60 }))).ok).toBe(true);
    expect(store({ now: () => NOW + 61_000 }).list()[0]!.state).toBe("expired");
    expect(store({ revoked: new Set(["lic_abc123"]) }).list()[0]!.state).toBe("revoked");
    writeFileSync(join(dir, LICENSES_DIR_NAME, "lic_abc123.key"), "壊れた中身", "utf8");
    expect(store().list()).toEqual([{ state: "invalid", problem: "format", licenseId: "lic_abc123" }]);
  });

  it("決済の試験用の鍵（s1）で署名したキーは、試験の設定（MXSTAGE_LICENSE_TEST=1）のときだけ受け付ける", async () => {
    const key = await issue(payload({ kid: "s1" }));
    expect(store().save(key)).toEqual({ ok: false, problem: "test_key" });
    const saved = store({ allowTestKeys: true }).save(key);
    expect(saved.ok && saved.license.test).toBe(true);
    expect(store().list()).toEqual([{ state: "invalid", problem: "test_key", licenseId: "lic_abc123" }]);
    expect(store().authorize(PROD)).toMatchObject({ ok: false, problem: "no_license" });
    expect(licenseTestKeysAllowed({ MXSTAGE_LICENSE_TEST: "1" })).toBe(true);
    expect(licenseTestKeysAllowed({ MXSTAGE_LICENSE_TEST: "true" })).toBe(false);
    expect(licenseTestKeysAllowed({})).toBe(false);
  });

  it("情報システム部門が licenses フォルダにキーのファイルを置いても読める", async () => {
    mkdirSync(join(dir, LICENSES_DIR_NAME), { recursive: true });
    writeFileSync(join(dir, LICENSES_DIR_NAME, "acme-production.key"), `${await issue(payload())}\r\n`, "utf8");
    writeFileSync(join(dir, LICENSES_DIR_NAME, "readme.txt"), "キーではない", "utf8");
    expect(store().list()).toMatchObject([{ state: "valid", licenseId: "lic_abc123" }]);
    expect(store().authorize(`${PROD}/maximo`).ok).toBe(true);
  });
});

describe("開発用のキー（--dev-license）", () => {
  it("ファイルに置かずに読んだキーも一覧に出て許可に使えるが、外せない。試験用の鍵のキーは試験の設定のときだけ", async () => {
    const devKey = await issue(payload({ kid: "s1", lic: "dev_fake_maximo", hosts: ["https://127.0.0.1:9797"] }));
    const dev = new LicenseStore({ dir, keys: KEYS, now: () => NOW, allowTestKeys: true, bundled: [devKey], revoked: new Set() });
    expect(dev.list()).toMatchObject([{ state: "valid", licenseId: "dev_fake_maximo", test: true, bundled: true }]);
    expect(dev.authorize("https://127.0.0.1:9797/maximo")).toMatchObject({ ok: true, license: { licenseId: "dev_fake_maximo" } });
    expect(dev.remove("dev_fake_maximo")).toBe(false);
    expect(dev.list()).toHaveLength(1);
    expect(keyFiles()).toEqual([]);

    const normal = new LicenseStore({ dir, keys: KEYS, now: () => NOW, bundled: [devKey], revoked: new Set() });
    expect(normal.list()).toMatchObject([{ state: "invalid", problem: "test_key", bundled: true }]);
    expect(normal.authorize("https://127.0.0.1:9797/maximo")).toMatchObject({ ok: false, problem: "no_license" });
  });
});

describe("本番への反映の許可（authorize）", () => {
  it("接続先のホストがキーの本番の接続先に含まれていれば許す（パス・大文字小文字・既定のポートの違いは同じ環境）", async () => {
    const s = store();
    s.save(await issue(payload({ hosts: [PROD, "https://maximo-internal.acme.example:9443"] })));
    for (const url of [`${PROD}/maximo`, "https://MAXIMO.acme.example:443/maximo/oslc", "https://maximo-internal.acme.example:9443/maximo"]) {
      expect(s.authorize(url), url).toMatchObject({ ok: true, license: { licenseId: "lic_abc123", org: "ACME Corp" } });
    }
    expect(s.authorize("https://maximo.acme.example:9443/maximo")).toMatchObject({ ok: false, problem: "not_licensed", licensedHosts: [PROD, "https://maximo-internal.acme.example:9443"] });
  });

  it("キーが無い・ライセンスに含まれない接続先・期限切れ・取り消し・読めない接続先は断る", async () => {
    expect(store().authorize(PROD)).toEqual({ ok: false, problem: "no_license", host: PROD, licensedHosts: [] });
    store().save(await issue(payload({ exp: SEC + 60 })));
    expect(store().authorize("https://other.acme.example/maximo")).toMatchObject({ ok: false, problem: "not_licensed", host: "https://other.acme.example" });
    expect(store({ now: () => NOW + 61_000 }).authorize(PROD)).toMatchObject({ ok: false, problem: "expired", licensedHosts: [] });
    expect(store({ revoked: new Set(["lic_abc123"]) }).authorize(PROD)).toMatchObject({ ok: false, problem: "revoked" });
    expect(store().authorize("maximo の本番")).toMatchObject({ ok: false, problem: "bad_scope", host: null });
  });

  it("同じ本番に期限切れのキーと更新したキーの両方があれば、期限内のキーで許す", async () => {
    const s = store({ now: () => NOW });
    s.save(await issue(payload({ exp: SEC + 60 })));
    s.save(await issue(payload({ lic: "lic_renewed", iat: SEC, exp: SEC + YEAR })));
    expect(store({ now: () => NOW + 61_000 }).authorize(PROD)).toMatchObject({ ok: true, license: { licenseId: "lic_renewed" } });
  });
});

describe("作業画面から使う入口（/_mxstage/license）", () => {
  const sameOrigin = (port: number) => ({ origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });

  it("一覧を返し、正しいキーだけを保存し、外せる。本番への反映の許可を返す", async () => {
    const bridge = await startTestBridge({ license: store() });
    const post = (path: string, body: unknown) => rawRequest(bridge, path, { method: "POST", headers: sameOrigin(bridge.port), body: JSON.stringify(body) });
    const first = await rawRequest(bridge, LICENSE_PATH);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true, licenses: [] });
    expect(first.headers["cache-control"]).toBe("no-store");

    const rejected = await post(LICENSE_PATH, { key: "MXS1.x.y" });
    expect(rejected.status).toBe(422);
    expect(JSON.parse(rejected.body)).toMatchObject({ ok: false, error: "license_rejected", problem: "format", licenses: [] });

    const key = await issue(payload());
    const saved = await post(LICENSE_PATH, { key });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ ok: true, license: { state: "valid", org: "ACME Corp", hosts: [PROD] }, licenses: [{ licenseId: "lic_abc123" }] });
    expect(saved.body).not.toContain("buyer@acme.example");
    expect(saved.body).not.toContain(key.split(".")[2]);

    const allowed = await post(LICENSE_AUTHORIZE_PATH, { baseUrl: `${PROD}/maximo` });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({ ok: true, host: PROD, license: { licenseId: "lic_abc123" } });
    const denied = await post(LICENSE_AUTHORIZE_PATH, { baseUrl: "https://other.example/maximo" });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ ok: false, error: "license_required", problem: "not_licensed", licensedHosts: [PROD] });

    const removed = await post(LICENSE_REMOVE_PATH, { licenseId: "lic_abc123" });
    expect(JSON.parse(removed.body)).toEqual({ ok: true, removed: true, licenses: [] });
  });

  it("同一オリジン以外（Origin の無い POST・別のオリジン）は受けない。大きすぎる本文・壊れた本文・違うメソッドも断る", async () => {
    const bridge = await startTestBridge({ license: store() });
    const key = await issue(payload());
    const noOrigin = await rawRequest(bridge, LICENSE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    expect(noOrigin.status).toBe(403);
    const foreign = await rawRequest(bridge, LICENSE_AUTHORIZE_PATH, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ baseUrl: PROD }) });
    expect(foreign.status).toBe(403);
    const crossSite = await rawRequest(bridge, LICENSE_REMOVE_PATH, { method: "POST", headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify({ licenseId: "x" }) });
    expect(crossSite.status).toBe(403);
    expect(keyFiles()).toEqual([]);

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
