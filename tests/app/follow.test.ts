// AI の作業に表示を合わせる（src/app/pages/follow.ts）: できたシート・AI が変えたシート・AI が反映を頼んだシートへ移り、
// 人の編集では移らず、人がタブを選んだ直後は動かさない。

import { describe, expect, it } from "vitest";
import { AiFollower, FOLLOW_PAUSE_MS } from "../../src/app/pages/follow";
import { Workspace } from "../../src/app/store";
import { makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";

function sheet(workspace: Workspace, name: string): string {
  const meta: SheetMeta = {
    name,
    source: { kind: "maximo", os: "MXAPIWO", select: ["SITEID", "WONUM", "DESCRIPTION"], where: [] },
    columns: [
      { name: "SITEID", type: "string", readOnly: true },
      { name: "WONUM", type: "string", readOnly: true },
      { name: "DESCRIPTION", type: "string" },
    ],
    keyColumns: ["SITEID", "WONUM"],
    childIdAttrs: {},
  };
  const rowKey = makeParentKey(["KITA", "148753"]);
  const rows: SheetRow[] = [{ rowKey, parentKey: rowKey, childName: null, values: { SITEID: "KITA", WONUM: "148753", DESCRIPTION: "起動不能" } }];
  workspace.createSheet(meta, rows);
  return rowKey;
}

/** 反映の依頼だけを持つ偽の CommitController */
function fakeCommits() {
  const listeners = new Set<(sheet: string) => void>();
  const panels = new Map<string, { state: string; requestedAt?: number }>();
  return {
    subscribe(l: (sheet: string) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    panel(sheet: string) {
      return panels.get(sheet) ?? { state: "idle" };
    },
    set(sheet: string, state: string, requestedAt?: number) {
      panels.set(sheet, requestedAt === undefined ? { state } : { state, requestedAt });
      for (const l of listeners) l(sheet);
    },
  };
}

function setup() {
  const workspace = new Workspace("作業");
  const commits = fakeCommits();
  const shown: string[] = [];
  let t = 1_000_000;
  const follower = new AiFollower({ workspace, commits, show: (s) => shown.push(s), now: () => t });
  const stop = follower.start();
  return { workspace, commits, shown, follower, stop, advance: (ms: number) => (t += ms) };
}

describe("AI の作業に表示を合わせる", () => {
  it("AI がシートを作ると、そのシートへ移る", () => {
    const { workspace, shown } = setup();
    sheet(workspace, "作業日報");
    sheet(workspace, "北部の是正保全");
    expect(shown).toEqual(["作業日報", "北部の是正保全"]);
  });

  it("AI がシートを変えると移り、人の編集では移らない", () => {
    const { workspace, shown } = setup();
    const key = sheet(workspace, "北部の是正保全");
    sheet(workspace, "作業日報");
    shown.length = 0;
    workspace.applyEdits("北部の是正保全", [{ rowKey: key, col: "DESCRIPTION", value: "起動不能（AI）" }], { author: "llm" });
    expect(shown).toEqual(["北部の是正保全"]);
    workspace.applyEdits("作業日報", [{ rowKey: key, col: "DESCRIPTION", value: "人の編集" }], { author: "user" });
    expect(shown).toEqual(["北部の是正保全"]);
  });

  it("反映の依頼が来ると、その依頼のシートへ 1 回だけ移る", () => {
    const { workspace, commits, shown } = setup();
    sheet(workspace, "北部の是正保全");
    shown.length = 0;
    commits.set("北部の是正保全", "requested", 1);
    commits.set("北部の是正保全", "requested", 1);
    expect(shown).toEqual(["北部の是正保全"]);
    commits.set("北部の是正保全", "idle");
    commits.set("北部の是正保全", "requested", 2);
    expect(shown).toEqual(["北部の是正保全", "北部の是正保全"]);
  });

  it("人がタブを選んだ直後は移らず、しばらくたつとまた合わせる", () => {
    const { workspace, shown, follower, advance } = setup();
    follower.userSelected();
    sheet(workspace, "作業日報");
    expect(shown).toEqual([]);
    advance(FOLLOW_PAUSE_MS + 1);
    sheet(workspace, "北部の是正保全");
    expect(shown).toEqual(["北部の是正保全"]);
  });

  it("止めたあとは移らない", () => {
    const { workspace, shown, stop } = setup();
    stop();
    sheet(workspace, "作業日報");
    expect(shown).toEqual([]);
  });
});
