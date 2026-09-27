import { describe, expect, it } from "vitest";
import { makeChildRowKey, makeParentKey, parseRowKey } from "../../src/shared/sheet";

describe("row keys", () => {
  it("round-trips parent and child keys", () => {
    const parent = makeParentKey(["BEDFORD", "WO062041"]);
    const child = makeChildRowKey(parent, "EXT_WOPERMIT", 12345);
    expect(parseRowKey(child)).toEqual({ parentKey: parent, childName: "EXT_WOPERMIT", childId: "12345", isNewChild: false });
    expect(parseRowKey(parent).childName).toBeNull();
  });

  it("escapes separators inside key values", () => {
    const parent = makeParentKey(["A|B", "C#D:E"]);
    const child = makeChildRowKey(parent, "MULTIASSETLOCCI", "x:y");
    const parsed = parseRowKey(child);
    expect(parsed.parentKey).toBe(parent);
    expect(parsed.childId).toBe("x:y");
  });
});
