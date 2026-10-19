// 設定の「Skill と辞書」の試験で使う、橋渡しの代わり（/_mxstage/skills と /_mxstage/dictionaries・/_mxstage/member）。
// 呼ばれた入口と本文を calls に残す。

import { DictionaryClient } from "../../src/app/dictionaries/client";
import { SkillsApi } from "../../src/app/settings/skillsApi";

export interface FakeSkillsData {
  list?: Record<string, unknown>;
  places?: unknown[];
  dictionaries?: unknown[];
  /** /_mxstage/skills/get の答え（place と name で選ぶ） */
  get?: (q: URLSearchParams) => Record<string, unknown>;
  /** POST の答え（入口ごと） */
  post?: (path: string, body: Record<string, unknown>) => { status?: number; body: Record<string, unknown> };
}

export const ME = { id: "m_aaaaaaaaaaaaaaaa", name: "武藤" };

export function fakeSkillsBridge(data: FakeSkillsData = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname, body });
    switch (url.pathname) {
      case "/_mxstage/skills":
        return json({ ok: true, skills: [], problems: [], userSkillsDir: null, connection: null, pcDrafts: [], ...data.list });
      case "/_mxstage/skills/places":
        return json({ ok: true, places: data.places ?? [], member: ME });
      case "/_mxstage/skills/get":
        return json(data.get?.(url.searchParams) ?? { ok: false, error: "not_found", message: "not found" }, data.get ? 200 : 404);
      case "/_mxstage/skills/check":
        return json({ ok: true, check: { errors: [], warnings: [], secrets: [], bytes: 0 }, otherCustomers: [] });
      case "/_mxstage/dictionaries":
        return json({ ok: true, folder: { path: null, sync: null, reachable: true, writable: true, isDefault: true }, member: ME, dictionaries: data.dictionaries ?? [], version: "1" });
      case "/_mxstage/member":
        return json({ ok: true, member: ME });
      default: {
        const out = data.post?.(url.pathname, body ?? {}) ?? { body: { ok: true } };
        return json(out.body, out.status ?? 200);
      }
    }
  }) as typeof fetch;
  return { calls, skillsApi: new SkillsApi(fetchImpl), dictionaryClient: new DictionaryClient(fetchImpl) };
}
