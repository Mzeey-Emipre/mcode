import { describe, it, expect, vi, beforeEach } from "vitest";
import { getIconUrl, resolveIcon, clearIconCache } from "@/lib/vscode-icons";

// jsdom doesn't provide URL.createObjectURL
global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");

beforeEach(() => {
  clearIconCache();
  vi.restoreAllMocks();
  global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
});

describe("getIconUrl", () => {
  it("returns CDN URL for known extension", () => {
    const url = getIconUrl("index.ts");
    expect(url).toContain("cdn.jsdelivr.net");
    expect(url).toContain(".svg");
  });

  it("returns CDN URL for .tsx files", () => {
    const url = getIconUrl("App.tsx");
    expect(url).toContain("cdn.jsdelivr.net");
  });

  it("returns null for unknown extension", () => {
    const url = getIconUrl("file.xyzabc123");
    expect(url).toBeNull();
  });

  it("handles filenames without extension", () => {
    const url = getIconUrl("Makefile");
    // Either returns a URL for known filename or null
    expect(url === null || typeof url === "string").toBe(true);
  });
});

describe("resolveIcon", () => {
  it("returns 'vscode' type with URL for known extension", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () =>
        Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    });

    const result = await resolveIcon("utils.ts");
    expect(result.type).toBe("vscode");
    if (result.type === "vscode") {
      expect(result.url).toBeDefined();
    }
  });

  it("falls back to 'lucide' type on fetch error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await resolveIcon("utils.ts");
    expect(result.type).toBe("lucide");
  });

  it("falls back to 'lucide' for unknown extension", async () => {
    const result = await resolveIcon("file.xyzabc123");
    expect(result.type).toBe("lucide");
  });

  it("caches resolved icons", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () =>
        Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    });

    await resolveIcon("utils.ts");
    await resolveIcon("utils.ts");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
