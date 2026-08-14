import { describe, it, expect } from "vitest";
import {
  selectTabsToDiscard,
  type WarmTabRef,
  type DiscardConfig,
} from "../discard-policy.js";

const CONFIG: DiscardConfig = { maxWarm: 3, bgIdleMs: 300_000, hiddenIdleMs: 60_000 };
const NOW = 10_000_000;

/** Helper: a warm tab whose last activation was `idleMs` before NOW. */
function tab(id: string, idleMs: number, threadId = "t1"): WarmTabRef {
  return { tabId: id, threadId, lastActiveAt: NOW - idleMs };
}

describe("selectTabsToDiscard — panel visible", () => {
  it("never discards the active tab even when idle past bgIdleMs", () => {
    const tabs = [tab("active", 999_999), tab("bg", 10_000)];
    const out = selectTabsToDiscard(tabs, "t1", "active", true, NOW, CONFIG);
    expect(out).not.toContain("active");
  });

  it("discards a background tab idle >= bgIdleMs", () => {
    const tabs = [tab("active", 0), tab("bg", 300_000)];
    const out = selectTabsToDiscard(tabs, "t1", "active", true, NOW, CONFIG);
    expect(out).toEqual(["bg"]);
  });

  it("keeps a background tab idle < bgIdleMs", () => {
    const tabs = [tab("active", 0), tab("bg", 299_999)];
    const out = selectTabsToDiscard(tabs, "t1", "active", true, NOW, CONFIG);
    expect(out).toEqual([]);
  });

  it("does NOT enforce the count cap while visible", () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(`t${i}`, 1_000));
    const out = selectTabsToDiscard(tabs, "t1", "t0", true, NOW, CONFIG);
    expect(out).toEqual([]);
  });

  it("discards background tabs across threads when idle", () => {
    const tabs = [tab("a", 0, "t1"), tab("b", 400_000, "t2")];
    const out = selectTabsToDiscard(tabs, "t1", "a", true, NOW, CONFIG);
    expect(out).toEqual(["b"]);
  });
});

describe("selectTabsToDiscard — panel hidden", () => {
  it("trims to the maxWarm most-recently-used tabs", () => {
    const tabs = [
      tab("mru1", 70_000),
      tab("mru2", 80_000),
      tab("mru3", 90_000),
      tab("lru1", 100_000),
      tab("lru2", 110_000),
    ];
    const out = selectTabsToDiscard(tabs, "t1", "mru1", false, NOW, CONFIG);
    expect(out.sort()).toEqual(["lru1", "lru2"]);
  });

  it("does NOT protect the active tab when hidden", () => {
    const tabs = [
      tab("active", 200_000),
      tab("b", 70_000),
      tab("c", 71_000),
      tab("d", 72_000),
    ];
    const out = selectTabsToDiscard(tabs, "t1", "active", false, NOW, CONFIG);
    expect(out).toEqual(["active"]);
  });

  it("keeps everything when warm count <= maxWarm", () => {
    const tabs = [tab("a", 200_000), tab("b", 300_000)];
    const out = selectTabsToDiscard(tabs, "t1", "a", false, NOW, CONFIG);
    expect(out).toEqual([]);
  });

  it("grants overflow tabs hiddenIdleMs grace before discarding", () => {
    const tabs = [
      tab("a", 0),
      tab("b", 1_000),
      tab("c", 2_000),
      tab("overflow", 30_000),
    ];
    const out = selectTabsToDiscard(tabs, "t1", "a", false, NOW, CONFIG);
    expect(out).toEqual([]);
  });

  it("works with null active identifiers (pure cap behavior)", () => {
    const tabs = [tab("a", 70_000), tab("b", 80_000), tab("c", 90_000), tab("d", 100_000)];
    const out = selectTabsToDiscard(tabs, null, null, false, NOW, CONFIG);
    expect(out).toEqual(["d"]);
  });
});

describe("selectTabsToDiscard — edges", () => {
  it("returns [] for no warm tabs", () => {
    expect(selectTabsToDiscard([], "t1", "x", true, NOW, CONFIG)).toEqual([]);
    expect(selectTabsToDiscard([], "t1", "x", false, NOW, CONFIG)).toEqual([]);
  });
});
