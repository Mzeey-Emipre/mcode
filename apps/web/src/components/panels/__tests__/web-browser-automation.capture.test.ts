import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureVisibleWebScreenshot,
  captureVisibleWebSnapshot,
} from "../web-browser-automation/capture";
import {
  bindWebBrowserAutomationTargets,
  clearWebBrowserAutomationBinding,
  registerWebBrowserAutomationTarget,
  resolveWebBrowserAutomationTarget,
  unregisterWebBrowserAutomationTarget,
} from "../web-browser-automation/targetRegistry";

function iframeFixture(): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  const frameDocument = document.implementation.createHTMLDocument("fixture");
  const secretValue = ["demo", "secret", "value"].join("-");
  const jwtLikeValue = ["eyJabcdefghijk", "abcdefghijklmnop"].join(".");
  frameDocument.body.innerHTML = `<input name="apiToken" value="${secretValue}"><p>Bearer ${jwtLikeValue}</p>`;
  Object.defineProperty(iframe, "contentDocument", { configurable: true, value: frameDocument });
  Object.defineProperty(iframe, "contentWindow", { configurable: true, value: { location: { origin: window.location.origin } } });
  Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 2_000 });
  Object.defineProperty(iframe, "clientHeight", { configurable: true, value: 1_000 });
  return iframe;
}

describe("web browser automation capture mechanics", () => {
  beforeEach(() => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      `data:image/png;base64,${"A".repeat(100)}`,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("captures a bounded viewport and redacts sensitive fixture values", async () => {
    const result = await captureVisibleWebScreenshot({ iframe: iframeFixture(), maxWidth: 2_000, deadline: Date.now() + 1_000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.width).toBe(1_280);
    const snapshot = await captureVisibleWebSnapshot({ iframe: iframeFixture(), maxWidth: 100, deadline: Date.now() + 1_000, includeScreenshot: false });
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.visibleText).not.toContain(["demo", "secret", "value"].join("-"));
      expect(snapshot.value.visibleText).not.toContain(["eyJabcdefghijk", "abcdefghijklmnop"].join("."));
      expect(snapshot.value.elements[0]?.value).toBeUndefined();
    }
  });

  it("bounds screenshot canvas area and visible text", async () => {
    const iframe = iframeFixture();
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 1_280 });
    Object.defineProperty(iframe, "clientHeight", { configurable: true, value: 10_000 });
    const screenshot = await captureVisibleWebScreenshot({ iframe, maxWidth: 1_280, deadline: Date.now() + 1_000 });
    expect(screenshot.ok).toBe(true);
    if (screenshot.ok) expect(screenshot.value.height).toBeLessThanOrEqual(6_250);

    iframe.contentDocument!.body.textContent = "x".repeat(25_000);
    const snapshot = await captureVisibleWebSnapshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, includeScreenshot: false });
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.visibleText.length).toBeLessThanOrEqual(20_000);
      expect(snapshot.value.visibleTextTruncation.truncated).toBe(true);
    }
  });

  it("reports bounded DOM clone truncation while preserving PNG output", async () => {
    const iframe = iframeFixture();
    iframe.contentDocument!.body.innerHTML = Array.from(
      { length: 1_001 },
      (_, index) => `<div>Node ${index}</div>`,
    ).join("");
    const result = await captureVisibleWebScreenshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mediaType).toBe("image/png");
      expect(result.value.dataBase64.length).toBeGreaterThan(0);
      expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalled();
      expect(result.value.width).toBe(100);
      expect(result.value.truncation).toMatchObject({ truncated: true, reason: "entry-limit" });
      if (result.value.truncation.truncated) expect(result.value.truncation.originalCount).toBeGreaterThan(result.value.width);
    }
  });

  it("returns stable timeout and cancellation failures", async () => {
    const iframe = iframeFixture();
    const timedOut = await captureVisibleWebScreenshot({ iframe, maxWidth: 100, deadline: Date.now() - 1 });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.code).toBe("TIMEOUT");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await captureVisibleWebSnapshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, signal: controller.signal, includeScreenshot: false });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.code).toBe("OPERATION_CANCELLED");
  });

  it("fails closed for cross-origin iframe access", async () => {
    const iframe = iframeFixture();
    Object.defineProperty(iframe, "contentWindow", { configurable: true, value: { location: { origin: "https://evil.example" } } });
    const result = await captureVisibleWebSnapshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, includeScreenshot: false });
    expect(result).toEqual({ ok: false, code: "CROSS_ORIGIN" });
  });

  it("returns timeout and cancellation when image work never settles", async () => {
    class HangingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {}
    }
    vi.stubGlobal("Image", HangingImage);
    const iframe = iframeFixture();
    const timedOut = await captureVisibleWebScreenshot({ iframe, maxWidth: 100, deadline: Date.now() + 2 });
    expect(timedOut).toEqual({ ok: false, code: "TIMEOUT" });
    const controller = new AbortController();
    const pending = captureVisibleWebScreenshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, code: "OPERATION_CANCELLED" });
  });

  it("classifies tainted canvas and bounded oversized output", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    await expect(captureVisibleWebScreenshot({ iframe: iframeFixture(), maxWidth: 100, deadline: Date.now() + 1_000 })).resolves.toEqual({ ok: false, code: "CROSS_ORIGIN" });
    vi.restoreAllMocks();
    class FastImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", FastImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(`data:image/png;base64,${"A".repeat(800_000)}`);
    await expect(captureVisibleWebScreenshot({ iframe: iframeFixture(), maxWidth: 100, deadline: Date.now() + 1_000 })).resolves.toEqual({ ok: false, code: "RESULT_TOO_LARGE" });
  });

  it("collects only rendered text and excludes sensitive subtrees", async () => {
    const iframe = iframeFixture();
    iframe.contentDocument!.body.innerHTML = [
      "<p>Visible text</p>",
      "<p hidden>Hidden secret</p>",
      "<script>Script secret</script>",
      "<style>Style secret</style>",
      "<template>Template secret</template>",
      "<textarea>Textarea secret</textarea>",
      "<input type=\"password\" value=\"Password secret\">",
      "<div data-token=\"credential\"><p>Subtree secret</p></div>",
    ].join("");
    const result = await captureVisibleWebSnapshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, includeScreenshot: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.visibleText).toContain("Visible text");
      for (const secret of ["Hidden secret", "Script secret", "Style secret", "Template secret", "Textarea secret", "Password secret", "Subtree secret"]) {
        expect(result.value.visibleText).not.toContain(secret);
      }
    }
  });

  it("aborts before image work when aggregate attributes exceed count or byte bounds", async () => {
    class ShouldNotLoadImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { throw new Error("image work should not start"); }
    }
    vi.stubGlobal("Image", ShouldNotLoadImage);
    const countIframe = iframeFixture();
    const countNode = countIframe.contentDocument!.createElement("div");
    for (let index = 0; index < 4_001; index += 1) countNode.setAttribute(`data-${index}`, "x");
    countIframe.contentDocument!.body.appendChild(countNode);
    await expect(captureVisibleWebScreenshot({ iframe: countIframe, maxWidth: 100, deadline: Date.now() + 1_000 })).resolves.toEqual({ ok: false, code: "RESULT_TOO_LARGE" });

    const byteIframe = iframeFixture();
    for (let index = 0; index < 100; index += 1) {
      const node = byteIframe.contentDocument!.createElement("div");
      node.setAttribute(`data-${index}`, "x".repeat(2_048));
      byteIframe.contentDocument!.body.appendChild(node);
    }
    await expect(captureVisibleWebScreenshot({ iframe: byteIframe, maxWidth: 100, deadline: Date.now() + 1_000 })).resolves.toEqual({ ok: false, code: "RESULT_TOO_LARGE" });
  });

  it("aborts before image construction when hidden source children exceed the traversal bound", async () => {
    let imageConstructed = false;
    class ShouldNotConstructImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { imageConstructed = true; }
      set src(_value: string) { throw new Error("image work should not start"); }
    }
    vi.stubGlobal("Image", ShouldNotConstructImage);
    const iframe = iframeFixture();
    iframe.contentDocument!.body.innerHTML = Array.from({ length: 16_001 }, () => "<div hidden></div>").join("");
    await expect(captureVisibleWebScreenshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000 })).resolves.toEqual({ ok: false, code: "RESULT_TOO_LARGE" });
    expect(imageConstructed).toBe(false);
  });

  it("copies bounded computed styles into the serialized preview", async () => {
    let source = "";
    class CapturingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) { source = value; queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", CapturingImage);
    const iframe = iframeFixture();
    const styled = iframe.contentDocument!.createElement("div");
    styled.textContent = "Styled";
    styled.setAttribute("style", "color: rgb(1, 2, 3); display: flex;");
    iframe.contentDocument!.body.appendChild(styled);
    await expect(captureVisibleWebScreenshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000 })).resolves.toMatchObject({ ok: true });
    expect(decodeURIComponent(source.split(",", 2)[1] ?? "")).toContain("color");
    expect(decodeURIComponent(source.split(",", 2)[1] ?? "")).toContain("display");
  });

  it("reports actual element truncation after bounded collection", async () => {
    const iframe = iframeFixture();
    const body = iframe.contentDocument!.body;
    body.innerHTML = Array.from({ length: 300 }, (_, index) => `<button id="button-${index}">Button ${index}</button>`).join("");
    const result = await captureVisibleWebSnapshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, includeScreenshot: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const truncation = result.value.elementsTruncation;
      expect(truncation.truncated).toBe(true);
      if (truncation.truncated) expect(truncation.originalCount).toBeGreaterThan(200);
    }
  });

  it("reports truncation and bounded original counts for oversized root child lists", async () => {
    const iframe = iframeFixture();
    iframe.contentDocument!.body.innerHTML = Array.from(
      { length: 1_001 },
      (_, index) => `<button>Root ${index}</button>`,
    ).join("");
    const result = await captureVisibleWebSnapshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, includeScreenshot: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.visibleTextTruncation).toMatchObject({ truncated: true });
      expect(result.value.elementsTruncation).toMatchObject({ truncated: true });
      if (result.value.visibleTextTruncation.truncated) expect(result.value.visibleTextTruncation.originalCount).toBeGreaterThan(1_000);
      if (result.value.elementsTruncation.truncated) expect(result.value.elementsTruncation.originalCount).toBeGreaterThan(1_000);
    }
  });

  it("reports truncation and bounded original counts for oversized nested child lists", async () => {
    const iframe = iframeFixture();
    iframe.contentDocument!.body.innerHTML = `<div id="nested">${Array.from(
      { length: 1_001 },
      (_, index) => `<button>Nested ${index}</button>`,
    ).join("")}</div>`;
    const result = await captureVisibleWebSnapshot({ iframe, maxWidth: 100, deadline: Date.now() + 1_000, includeScreenshot: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.visibleTextTruncation).toMatchObject({ truncated: true });
      expect(result.value.elementsTruncation).toMatchObject({ truncated: true });
      if (result.value.visibleTextTruncation.truncated) expect(result.value.visibleTextTruncation.originalCount).toBeGreaterThan(1_000);
      if (result.value.elementsTruncation.truncated) expect(result.value.elementsTruncation.originalCount).toBeGreaterThan(1_000);
    }
  });

  it("rejects stale target generations and releases replaced registrations", () => {
    const iframe = document.createElement("iframe");
    const identity = { worktreeIdentity: "worktree", connectionId: "pending-desktop", workspaceId: "workspace", threadId: "thread", tabId: "tab", generation: 2 } as const;
    registerWebBrowserAutomationTarget({ identity, iframe, connectionGeneration: 4 });
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 1, desktopInstanceId: "desktop", connectionGeneration: 1 })).toBeNull();
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 2, desktopInstanceId: "desktop", connectionGeneration: 1 })).toBeNull();
    bindWebBrowserAutomationTargets("worktree", "desktop", 4);
    const replacement = document.createElement("iframe");
    registerWebBrowserAutomationTarget({ identity, iframe: replacement, connectionGeneration: 4 });
    bindWebBrowserAutomationTargets("worktree", "desktop", 4);
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 2, desktopInstanceId: "desktop", connectionGeneration: 4 })?.iframe).toBe(replacement);
    unregisterWebBrowserAutomationTarget(identity, iframe);
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 2, desktopInstanceId: "desktop", connectionGeneration: 4 })?.iframe).toBe(replacement);
    unregisterWebBrowserAutomationTarget(identity, replacement);
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 2, desktopInstanceId: "desktop", connectionGeneration: 4 })).toBeNull();
  });

  it("invalidates the old lease while retaining a mounted target for rebinding", () => {
    const iframe = document.createElement("iframe");
    const identity = { worktreeIdentity: "worktree", connectionId: "pending-desktop", workspaceId: "workspace", threadId: "thread", tabId: "tab", generation: 7 } as const;
    registerWebBrowserAutomationTarget({ identity, iframe });
    bindWebBrowserAutomationTargets("worktree", "desktop-1", 8);
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 7, desktopInstanceId: "desktop-1", connectionGeneration: 8 })?.iframe).toBe(iframe);
    clearWebBrowserAutomationBinding("worktree");
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 7, desktopInstanceId: "desktop-1", connectionGeneration: 8 })).toBeNull();
    bindWebBrowserAutomationTargets("worktree", "desktop-2", 9);
    expect(resolveWebBrowserAutomationTarget({ ...identity, targetGeneration: 7, desktopInstanceId: "desktop-2", connectionGeneration: 9 })?.iframe).toBe(iframe);
  });
});
