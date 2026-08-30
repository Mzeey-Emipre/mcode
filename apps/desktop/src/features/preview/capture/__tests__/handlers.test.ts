import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCODE_BROWSER_CAPTURE_V2_STRING_MAX } from "@mcode/contracts";

const captureTest = vi.hoisted(() => {
  const ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
  const session = {
    lastBounds: { x: 40, y: 60, width: 800, height: 600 },
    consoleBuffer: [] as string[],
    failedRequestBuffer: [] as Array<{ url: string; statusCode: number; resourceType: string }>,
    workspaceId: "workspace-A",
  };
  const webContents = {
    id: 101,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "https://example.test/page"),
    getTitle: vi.fn(() => "Example page"),
    executeJavaScript: vi.fn(),
    capturePage: vi.fn(),
  };
  const window = { id: 11, isDestroyed: vi.fn(() => false) };
  return {
    ipcHandlers,
    session,
    webContents,
    window,
    currentWindow: window as typeof window | null,
    activeWebContents: webContents as typeof webContents | null,
    persistSpill: vi.fn(),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => captureTest.currentWindow),
  },
  app: { getPath: vi.fn(() => "C:\\temp") },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      captureTest.ipcHandlers[channel] = handler;
    }),
  },
}));

vi.mock("../../state/window-session.js", () => ({
  getSession: vi.fn(() => captureTest.session),
  sessions: new Map([[captureTest.window.id, captureTest.session]]),
}));

vi.mock("../../surfaces/active-web-contents.js", () => ({
  resolveActivePreviewWebContents: vi.fn(() => captureTest.activeWebContents),
}));

vi.mock("../spill-store.js", () => ({
  persistBrowserCaptureSpill: captureTest.persistSpill,
}));

import {
  PREVIEW_CONSOLE_BUFFER_MAX,
  PREVIEW_CONSOLE_LINE_MAX,
  PREVIEW_FAILED_REQUEST_MAX,
  SELECTOR_HINT_MAX_LEN,
  buildBrowserCapturePayload,
  clampRectInPlace,
  formatConsoleTail,
  parseBoundsRecord,
  previewCaptureFileStem,
  pushFailedRequest,
  pushPreviewConsoleLine,
  registerCaptureHandlers,
  sanitizeSelectorHintFromGuest,
  scrubHtmlExcerptForOutbound,
  snapshotFailedRequestsForCapture,
  viewportBoundsFallback,
} from "../handlers.js";

function contextResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    visibleText: "Visible text",
    headingOutline: "H1: Heading",
    interactiveOutline: "- [button] Save",
    scrollX: 4,
    scrollY: 8,
    layoutWidth: 800,
    layoutHeight: 600,
    ...overrides,
  });
}

function captureImage(bytes = "png-bytes") {
  return {
    toPNG: vi.fn(() => Buffer.from(bytes)),
    getSize: vi.fn(() => ({ width: 800, height: 600 })),
  };
}

describe("Preview capture handlers", () => {
  beforeEach(() => {
    for (const channel of Object.keys(captureTest.ipcHandlers)) delete captureTest.ipcHandlers[channel];
    captureTest.currentWindow = captureTest.window;
    captureTest.activeWebContents = captureTest.webContents;
    captureTest.window.isDestroyed.mockReturnValue(false);
    captureTest.webContents.isDestroyed.mockReturnValue(false);
    captureTest.webContents.getURL.mockReturnValue("https://example.test/page");
    captureTest.webContents.getTitle.mockReturnValue("Example page");
    captureTest.webContents.executeJavaScript.mockReset().mockResolvedValue(contextResult());
    captureTest.webContents.capturePage.mockReset().mockResolvedValue(captureImage());
    captureTest.session.lastBounds = { x: 40, y: 60, width: 800, height: 600 };
    captureTest.session.consoleBuffer.length = 0;
    captureTest.session.failedRequestBuffer.length = 0;
    captureTest.session.workspaceId = "workspace-A";
    captureTest.persistSpill.mockReset().mockResolvedValue(null);
    registerCaptureHandlers();
  });

  it("returns the picture and context result shapes from the active Preview guest", async () => {
    const event = { sender: {} };

    const picture = await captureTest.ipcHandlers["preview:capture-picture-reference"]!(event) as {
      ok: true;
      meta: { name: string; mimeType: string; sizeBytes: number; sourcePath: string };
      previewBytes: Uint8Array;
      capture: { pageUrl: string; pageTitle: string; bounds: unknown; visibleTextExcerpt?: string };
    };
    const context = await captureTest.ipcHandlers["preview:capture-context-reference"]!(event) as {
      ok: true;
      capture: { pageUrl: string; pageTitle: string; bounds: unknown; visibleTextExcerpt?: string };
    };

    expect(picture).toMatchObject({
      ok: true,
      meta: {
        name: expect.stringMatching(/^preview-example\.test-\d+\.png$/),
        mimeType: "image/png",
        sizeBytes: 9,
        sourcePath: expect.stringMatching(/[\\/]mcode-attachments[\\/][0-9a-f-]+\.png$/),
      },
      capture: {
        pageUrl: "https://example.test/page",
        pageTitle: "Example page",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visibleTextExcerpt: "Visible text",
      },
    });
    expect([...picture.previewBytes]).toEqual([...Buffer.from("png-bytes")]);
    expect(context).toMatchObject({
      ok: true,
      capture: {
        pageUrl: "https://example.test/page",
        pageTitle: "Example page",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visibleTextExcerpt: "Visible text",
      },
    });
    expect(captureTest.webContents.capturePage).toHaveBeenCalledOnce();
  });

  it("keeps the established capture errors for missing state and capture failures", async () => {
    const event = { sender: {} };
    captureTest.currentWindow = null;
    await expect(captureTest.ipcHandlers["preview:capture-picture-reference"]!(event)).resolves.toEqual({
      ok: false,
      error: "no-window",
    });

    captureTest.currentWindow = captureTest.window;
    captureTest.activeWebContents = null;
    await expect(captureTest.ipcHandlers["preview:capture-context-reference"]!(event)).resolves.toEqual({
      ok: false,
      error: "no-preview",
    });

    captureTest.activeWebContents = captureTest.webContents;
    captureTest.session.lastBounds = null as never;
    await expect(captureTest.ipcHandlers["preview:capture-context-reference"]!(event)).resolves.toEqual({
      ok: false,
      error: "no-bounds",
    });

    captureTest.session.lastBounds = { x: 0, y: 0, width: 800, height: 600 };
    captureTest.webContents.capturePage.mockRejectedValueOnce(new Error("capture failed"));
    await expect(captureTest.ipcHandlers["preview:capture-picture-reference"]!(event)).resolves.toEqual({
      ok: false,
      error: "capture-failed",
    });
  });

  it("clamps annotation rectangles to the visible viewport before capture", async () => {
    captureTest.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes("requestAnimationFrame")) return true;
      if (script.includes("visibleText")) return contextResult();
      return undefined;
    });

    const result = await captureTest.ipcHandlers["preview:capture-annotation-snapshot"]!(
      { sender: {} },
      {
        activeDisplayNumber: 2,
        activeBounds: { x: 790.9, y: 590.2, width: 100, height: 100 },
        markers: [{ displayNumber: 2, bounds: { x: 790.9, y: 590.2, width: 100, height: 100 } }],
      },
    );

    expect(result).toMatchObject({ ok: true });
    const overlayScript = captureTest.webContents.executeJavaScript.mock.calls[0]![0] as string;
    expect(overlayScript).toContain('"activeBounds":{"x":790,"y":590,"width":10,"height":10}');
    expect(captureTest.webContents.capturePage).toHaveBeenCalledWith();
  });
});

describe("Preview capture bounds and outbound data", () => {
  it("rejects malformed bounds and clamps valid bounds inside the viewport", () => {
    expect(parseBoundsRecord({ x: 1, y: 2, width: Number.NaN, height: 4 })).toBeNull();
    expect(clampRectInPlace({ x: -4.8, y: 9.9, width: 50.7, height: 30.2 }, 32, 24)).toEqual({
      x: 0,
      y: 9,
      width: 32,
      height: 15,
    });
    expect(viewportBoundsFallback(0, -4)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("sanitizes HTML and selector hints at the guest boundary", () => {
    expect(scrubHtmlExcerptForOutbound("<p>Safe</p>\u0000<script>steal()</script><iframe src='x'></iframe>"))
      .toBe("<p>Safe</p><!-- stripped --><!-- stripped -->");
    expect(sanitizeSelectorHintFromGuest(`  button\u0000.${"x".repeat(SELECTOR_HINT_MAX_LEN)}  `))
      .toBe(`button.${"x".repeat(SELECTOR_HINT_MAX_LEN - 7)}`);
    expect(sanitizeSelectorHintFromGuest("\u0000\n\t")).toBeNull();
  });

  it("bounds console lines and failed requests with oldest-entry eviction", () => {
    const session = { consoleBuffer: [] as string[], failedRequestBuffer: [] as Array<{ url: string; statusCode: number; resourceType: string }> };
    for (let index = 0; index <= PREVIEW_CONSOLE_BUFFER_MAX; index += 1) {
      pushPreviewConsoleLine(session as never, 3, `line-${index}-${"x".repeat(PREVIEW_CONSOLE_LINE_MAX)}`);
    }
    for (let index = 0; index <= PREVIEW_FAILED_REQUEST_MAX; index += 1) {
      pushFailedRequest(session as never, { url: `https://example.test/${index}/${"u".repeat(2100)}`, statusCode: 500, resourceType: "xhr" });
    }

    expect(session.consoleBuffer).toHaveLength(PREVIEW_CONSOLE_BUFFER_MAX);
    expect(session.consoleBuffer[0]).toContain("line-1-");
    expect(session.consoleBuffer.every((line) => line.length <= PREVIEW_CONSOLE_LINE_MAX)).toBe(true);
    expect(formatConsoleTail(session.consoleBuffer)).toHaveLength(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.consoleTail);
    expect(session.failedRequestBuffer).toHaveLength(PREVIEW_FAILED_REQUEST_MAX);
    expect(session.failedRequestBuffer[0]!.url).toContain("/1/");
    const snapshot = snapshotFailedRequestsForCapture(session as never)!;
    expect(snapshot[0]!.url).toHaveLength(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.failedRequestUrl);
    expect(snapshot[0]!.statusCode).toBe(500);
    expect(snapshot[0]!.resourceType).toBe("xhr");
  });

  it("redacts and clamps hostile guest text while spilling the full redacted payload", async () => {
    const oversizedText = `person@example.test ${"x".repeat(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.visibleTextExcerpt + 20)}`;
    captureTest.webContents.executeJavaScript.mockResolvedValue(contextResult({ visibleText: oversizedText }));
    captureTest.persistSpill.mockResolvedValue({
      appDataPath: "browser-capture-spill/workspace-a/11111111-1111-4111-8111-111111111111.json",
      absolutePath: "C:\\mcode\\browser-capture-spill\\workspace-a\\11111111-1111-4111-8111-111111111111.json",
    });

    const result = await buildBrowserCapturePayload(
      captureTest.webContents as never,
      { x: 0, y: 0, width: 800, height: 600 },
      ["console person@example.test"],
      [{ url: `https://example.test/${"u".repeat(3000)}`, statusCode: 500, resourceType: "x".repeat(80) }],
      "workspace-A",
      { htmlExcerpt: `<script>remove()</script>contact person@example.test ${"h".repeat(17_000)}` },
    );

    expect(result.visibleTextExcerpt).toHaveLength(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.visibleTextExcerpt);
    expect(result.visibleTextExcerpt).toContain("[redacted-email]");
    expect(result.htmlExcerpt).toHaveLength(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.htmlExcerpt);
    expect(result.htmlExcerpt).not.toContain("<script>");
    expect(result.consoleTail).toBe("console [redacted-email]");
    expect(result.failedRequests![0]!.url).toHaveLength(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.failedRequestUrl);
    expect(result.failedRequests![0]!.resourceType).toHaveLength(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.failedRequestResourceType);
    expect(result.spillAppDataPath).toBe("browser-capture-spill/workspace-a/11111111-1111-4111-8111-111111111111.json");
    const spilled = captureTest.persistSpill.mock.calls[0]![1] as { visibleTextExcerpt: string; htmlExcerpt: string };
    expect(spilled.visibleTextExcerpt.length).toBeGreaterThan(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.visibleTextExcerpt);
    expect(spilled.visibleTextExcerpt).not.toContain("person@example.test");
    expect(spilled.htmlExcerpt).not.toContain("<script>");
  });

  it("includes console lines received while guest context capture is pending", async () => {
    let resolveContext!: (value: string) => void;
    captureTest.webContents.executeJavaScript.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveContext = resolve;
    }));
    const consoleBuffer = ["log: before context"];
    const capture = buildBrowserCapturePayload(
      captureTest.webContents as never,
      { x: 0, y: 0, width: 800, height: 600 },
      consoleBuffer,
      [],
      "workspace-A",
    );
    consoleBuffer.push("warning: during context");
    resolveContext(contextResult());

    await expect(capture).resolves.toMatchObject({
      consoleTail: "log: before context\nwarning: during context",
    });
  });

  it("uses a bounded hostname or the page fallback in capture filenames", () => {
    expect(previewCaptureFileStem("https://docs.example.test/path")).toBe("docs.example.test");
    expect(previewCaptureFileStem("file:///C:/secret.txt")).toBe("page");
    expect(previewCaptureFileStem("not a URL")).toBe("page");
  });
});
