import { describe, it, expect } from "vitest";
import { pageStatusReducer, initialPageStatus } from "../preview/page-status-reducer.js";
import type { PreviewPageError } from "@mcode/contracts";

const ERR: PreviewPageError = { kind: "http", status: 404, message: "Page not found" };

describe("pageStatusReducer", () => {
  it("starts loaded with empty chrome", () => {
    expect(initialPageStatus()).toEqual({
      url: null,
      title: null,
      favicon: null,
      phase: "loaded",
    });
  });

  it("load-start enters loading and clears favicon + error", () => {
    const prev = { url: "https://a.test", title: "A", favicon: "f", phase: "error" as const, error: ERR };
    const next = pageStatusReducer(prev, { type: "load-start" });
    expect(next.phase).toBe("loading");
    expect(next.favicon).toBeNull();
    expect(next.error).toBeUndefined();
    // url/title carry across until navigated fires.
    expect(next.url).toBe("https://a.test");
    expect(next.title).toBe("A");
  });

  it("loading -> loaded via load-stop", () => {
    const loading = pageStatusReducer(initialPageStatus(), { type: "load-start", url: "https://x.test" });
    expect(loading.phase).toBe("loading");
    const loaded = pageStatusReducer(loading, { type: "load-stop" });
    expect(loaded.phase).toBe("loaded");
    expect(loaded.url).toBe("https://x.test");
  });

  it("loading -> error via load-error, clearing the loading affordance and favicon", () => {
    const loading = pageStatusReducer(initialPageStatus(), { type: "load-start", url: "https://x.test" });
    const errored = pageStatusReducer(loading, { type: "load-error", error: ERR });
    expect(errored.phase).toBe("error");
    expect(errored.favicon).toBeNull();
    expect(errored.error).toEqual(ERR);
  });

  it("load-error adopts the failed URL when carried, so the panel can show it", () => {
    const loading = pageStatusReducer(initialPageStatus(), { type: "load-start" });
    const errored = pageStatusReducer(loading, {
      type: "load-error",
      error: { kind: "network", message: "Can't reach this site" },
      url: "https://nope.test",
    });
    expect(errored.phase).toBe("error");
    expect(errored.url).toBe("https://nope.test");
  });

  it("error -> loading on retry (load-start)", () => {
    const errored = { url: "https://x.test", title: null, favicon: null, phase: "error" as const, error: ERR };
    const retry = pageStatusReducer(errored, { type: "load-start" });
    expect(retry.phase).toBe("loading");
    expect(retry.error).toBeUndefined();
  });

  it("load-stop does not override an error phase", () => {
    const errored = { url: "https://x.test", title: null, favicon: null, phase: "error" as const, error: ERR };
    const after = pageStatusReducer(errored, { type: "load-stop" });
    expect(after.phase).toBe("error");
  });

  it("loaded -> discarded via discard, keeping cold chrome", () => {
    const loaded = { url: "https://x.test", title: "X", favicon: "fav", phase: "loaded" as const };
    const discarded = pageStatusReducer(loaded, { type: "discard" });
    expect(discarded.phase).toBe("discarded");
    expect(discarded.url).toBe("https://x.test");
    expect(discarded.title).toBe("X");
    expect(discarded.favicon).toBe("fav");
  });

  it("discarded -> loading on re-warm (load-start)", () => {
    const discarded = { url: "https://x.test", title: "X", favicon: "fav", phase: "discarded" as const };
    const rewarm = pageStatusReducer(discarded, { type: "load-start", url: "https://x.test" });
    expect(rewarm.phase).toBe("loading");
  });

  it("navigated sets url, keeps phase, and only overwrites title when non-empty", () => {
    const loading = pageStatusReducer(initialPageStatus(), { type: "load-start" });
    const nav = pageStatusReducer(loading, { type: "navigated", url: "https://y.test", title: "Y" });
    expect(nav.url).toBe("https://y.test");
    expect(nav.title).toBe("Y");
    expect(nav.phase).toBe("loading");
    const navEmptyTitle = pageStatusReducer(nav, { type: "navigated", url: "https://y.test/2", title: "" });
    expect(navEmptyTitle.title).toBe("Y");
  });

  it("title and favicon events patch only their field", () => {
    const base = { url: "https://x.test", title: "X", favicon: null, phase: "loaded" as const };
    expect(pageStatusReducer(base, { type: "title", title: "New" }).title).toBe("New");
    expect(pageStatusReducer(base, { type: "favicon", favicon: "fav" }).favicon).toBe("fav");
  });

  it("reset replaces the whole status", () => {
    const replacement = { url: "https://z.test", title: "Z", favicon: "zf", phase: "loaded" as const };
    expect(pageStatusReducer(initialPageStatus(), { type: "reset", status: replacement })).toEqual(replacement);
  });
});
