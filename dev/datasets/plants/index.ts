// 開発用の大きなデータ: 架空の広域事業組合（ORGID KANKYO）の、ごみ焼却施設 3 か所（稼働 20 年・13 年・5 年）。
// npm run dev:fake-maximo -- --dataset plants で偽の Maximo に載せる。内容と件数・仕込んだデータ品質の問題は dev/README.md。

import { withDefinitions, type FakeSeed } from "../../../tests/fakes/fake-maximo.ts";
import { generatePlants, type PlantsData, type PlantsOptions } from "./generate.ts";
import { plantsObjectStructures } from "./structures.ts";

export { generatePlants, NOW } from "./generate.ts";
export type { PlantsData, PlantsOptions, DataProblem } from "./generate.ts";
export { plantsObjectStructures } from "./structures.ts";

/** 偽の Maximo の種（オブジェクト構造の定義 MXAPIINTOBJECT を含む）と、生成したデータ */
export function plantsSeed(opts: PlantsOptions & { baseUrl?: string } = {}): { seed: FakeSeed; data: PlantsData } {
  const data = generatePlants(opts);
  // 長く動かすので、要求の記録（試験用）は残さない
  const seed: FakeSeed = { logRequests: false, objectStructures: plantsObjectStructures(data) };
  if (opts.baseUrl !== undefined) seed.baseUrl = opts.baseUrl;
  return { seed: withDefinitions(seed), data };
}

/** 起動時に出す件数の表（オブジェクト構造 × サイト） */
export function countsTable(seed: FakeSeed): string {
  const lines: string[] = [];
  for (const [name, os] of Object.entries(seed.objectStructures)) {
    if (os.recordsFrom) continue;
    const recs = os.records ?? [];
    const bySite = new Map<string, number>();
    let children = 0;
    for (const r of recs) {
      const s = typeof r.attrs.siteid === "string" ? r.attrs.siteid : null;
      if (s) bySite.set(s, (bySite.get(s) ?? 0) + 1);
      for (const list of Object.values(r.children ?? {})) children += list.length;
    }
    const sites = [...bySite.entries()].map(([s, n]) => `${s} ${n.toLocaleString("en-US")}`).join(", ");
    lines.push(`    ${name.padEnd(20)} ${recs.length.toLocaleString("en-US").padStart(8)}${sites ? `（${sites}）` : ""}${children > 0 ? ` 子 ${children.toLocaleString("en-US")}` : ""}`);
  }
  return lines.join("\n");
}
