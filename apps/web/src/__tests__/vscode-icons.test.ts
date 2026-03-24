import { describe, it, expect, vi, beforeEach } from "vitest";
import { getIconUrl, resolveIcon, clearIconCache } from "@/lib/vscode-icons";

// jsdom doesn't provide URL.createObjectURL
globalThis.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");

beforeEach(() => {
  clearIconCache();
  vi.restoreAllMocks();
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
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

  it("returns null for filenames that map to the default icon", () => {
    // Makefile maps to default_file.svg in vscode-icons-js, which we filter out
    const url = getIconUrl("Makefile");
    expect(url).toBeNull();
  });
});

describe("resolveIcon", () => {
  it("returns 'vscode' type with URL for known extension", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await resolveIcon("utils.ts");
    expect(result.type).toBe("lucide");
  });

  it("falls back to 'lucide' for unknown extension", async () => {
    const result = await resolveIcon("file.xyzabc123");
    expect(result.type).toBe("lucide");
  });

  it("caches resolved icons", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () =>
        Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    });

    await resolveIcon("utils.ts");
    await resolveIcon("utils.ts");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent fetches for the same file", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () =>
        Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    });

    // Fire two concurrent resolves before either settles
    const [r1, r2] = await Promise.all([
      resolveIcon("index.ts"),
      resolveIcon("index.ts"),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(r1.type).toBe("vscode");
    expect(r2.type).toBe("vscode");
  });
});
