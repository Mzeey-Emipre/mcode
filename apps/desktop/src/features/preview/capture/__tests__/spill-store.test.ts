import { beforeEach, describe, expect, it, vi } from "vitest";

const spillTest = vi.hoisted(() => ({
  ipcHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  window: { isDestroyed: vi.fn(() => false) } as { isDestroyed: ReturnType<typeof vi.fn> } | null,
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: spillTest.mkdir,
  writeFile: spillTest.writeFile,
  readdir: spillTest.readdir,
  stat: spillTest.stat,
  unlink: spillTest.unlink,
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => spillTest.window) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      spillTest.ipcHandlers[channel] = handler;
    }),
  },
}));

vi.mock("@mcode/shared", async () => {
  const actual = await vi.importActual<typeof import("@mcode/shared")>("@mcode/shared");
  return {
    ...actual,
    getMcodeDir: vi.fn(() => "C:\\mcode-data"),
    spillWorkspaceDirSegment: vi.fn(() => "workspace-a"),
  };
});

import { persistBrowserCaptureSpill, registerSpillHandlers } from "../spill-store.js";

const VALID_SPILL_PATH = "browser-capture-spill/workspace-a/11111111-1111-4111-8111-111111111111.json";

describe("Preview capture spill store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    for (const channel of Object.keys(spillTest.ipcHandlers)) delete spillTest.ipcHandlers[channel];
    spillTest.mkdir.mockReset().mockResolvedValue(undefined);
    spillTest.writeFile.mockReset().mockResolvedValue(undefined);
    spillTest.readdir.mockReset().mockResolvedValue([]);
    spillTest.stat.mockReset();
    spillTest.unlink.mockReset().mockResolvedValue(undefined);
    spillTest.window = { isDestroyed: vi.fn(() => false) };
  });

  it("writes only the bounded spill fields under the Preview spill root", async () => {
    const result = await persistBrowserCaptureSpill(" workspace-A ", {
      schemaVersion: 2,
      capturedAt: "2026-08-14T11:59:00.000Z",
      pageUrl: "https://example.test/page",
      pageTitle: "Example",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      selectorHint: null,
      visibleTextExcerpt: "full visible text",
      headingOutline: "H1: Example",
      failedRequests: [{ url: "https://example.test/fail", statusCode: 500 }],
    });

    expect(result).toEqual({
      appDataPath: VALID_SPILL_PATH,
      absolutePath: expect.stringMatching(/browser-capture-spill[\\/]workspace-a[\\/]11111111-1111-4111-8111-111111111111\.json$/),
    });
    expect(spillTest.mkdir).toHaveBeenCalledWith(
      expect.stringMatching(/browser-capture-spill[\\/]workspace-a$/),
      { recursive: true },
    );
    const body = JSON.parse(spillTest.writeFile.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: 1,
      capturedAt: "2026-08-14T11:59:00.000Z",
      pageUrl: "https://example.test/page",
      pageTitle: "Example",
      fields: {
        visibleTextExcerpt: "full visible text",
        headingOutline: "H1: Example",
      },
    });
    expect(await persistBrowserCaptureSpill("   ", {} as never)).toBeNull();
  });

  it("releases only validated Preview spill paths", async () => {
    registerSpillHandlers();
    const release = spillTest.ipcHandlers["preview:release-browser-capture-spill"]!;

    await release(
      { sender: {} },
      [
        VALID_SPILL_PATH,
        "browser-capture-spill/../secrets.json",
        "browser-capture-spill/workspace-a/not-a-uuid.json",
        42,
      ],
    );

    expect(spillTest.unlink).toHaveBeenCalledOnce();
    expect(spillTest.unlink).toHaveBeenCalledWith(
      expect.stringMatching(/browser-capture-spill[\\/]workspace-a[\\/]11111111-1111-4111-8111-111111111111\.json$/),
    );
  });

  it("runs one bounded startup prune and deletes only stale JSON files", async () => {
    spillTest.readdir
      .mockResolvedValueOnce([
        { name: "workspace-a", isDirectory: () => true },
        { name: "loose.json", isDirectory: () => false },
      ])
      .mockResolvedValueOnce(["stale.json", "fresh.json", "note.txt"]);
    spillTest.stat.mockImplementation(async (path: string) => ({
      mtimeMs: path.endsWith("stale.json") ? Date.now() - 8 * 24 * 60 * 60 * 1000 : Date.now(),
    }));
    registerSpillHandlers();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(spillTest.readdir).toHaveBeenCalledTimes(2);
    expect(spillTest.stat).toHaveBeenCalledTimes(2);
    expect(spillTest.unlink).toHaveBeenCalledOnce();
    expect(spillTest.unlink).toHaveBeenCalledWith(expect.stringMatching(/[\\/]stale\.json$/));
  });
});
