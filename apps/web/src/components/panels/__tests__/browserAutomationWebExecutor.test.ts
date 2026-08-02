import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, type BrowserAutomationHostDispatch } from "@mcode/contracts";
import { captureVisibleWebScreenshot } from "../web-browser-automation/capture";
import { executeWebBrowserDispatch } from "../browserAutomationWebExecutor";
import { executeWebInteraction, resolveWebTarget } from "../webBrowserInteractionExecutor";

vi.mock("../web-browser-automation/capture", () => ({ captureVisibleWebScreenshot: vi.fn() }));

function dispatch(operation: BrowserAutomationHostDispatch["request"]["operation"], args: Record<string, unknown> = {}, deadline = Date.now() + 1_000): BrowserAutomationHostDispatch {
  return {
    scope: { workspaceId: "workspace-1", threadId: "thread-1", providerSessionId: "session-1", providerInstanceId: "instance-1" },
    connection: { desktopInstanceId: "web", windowId: 1, connectionGeneration: 1, targetGeneration: 1 },
    request: {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      workspaceId: "workspace-1",
      threadId: "thread-1",
      providerSessionId: "session-1",
      providerInstanceId: "instance-1",
      requestId: `request-${operation}`,
      sequence: 1,
      deadline,
      expectedControlEpoch: 0,
      operation,
      args,
    } as BrowserAutomationHostDispatch["request"],
    target: { desktopInstanceId: "web", windowId: 1, connectionGeneration: 1, threadId: "thread-1", tabId: "tab-1", targetGeneration: 1, active: true, focused: true, lastUsedAt: 1 },
  };
}

function iframe(): HTMLIFrameElement {
  const element = document.createElement("iframe");
  element.dataset.threadId = "thread-1";
  element.dataset.tabId = "tab-1";
  element.src = "about:blank";
  document.body.append(element);
  const page = document.implementation.createHTMLDocument("Fixture");
  page.body.innerHTML = `<main>Hello <button>Save</button></main>`;
  Object.defineProperty(element, "contentDocument", { configurable: true, value: page });
  return element;
}

function expectTypedFailure(result: unknown): void {
  expect(result).toMatchObject({
    ok: false,
    error: {
      stage: expect.any(String),
      effect: expect.any(String),
      recovery: expect.any(String),
      correlationId: expect.any(String),
    },
  });
}

describe("web browser automation executor", () => {
  it("navigates the visible iframe and snapshots bounded semantic content", async () => {
    const target = iframe();
    const navigation = executeWebBrowserDispatch(dispatch("navigate", { url: `${window.location.origin}/next` }), new AbortController().signal);
    const page = target.contentDocument!;
    page.title = "Next page";
    page.body.innerHTML = `<main>Next <button>Continue</button></main>`;
    target.dispatchEvent(new Event("load"));
    const result = await navigation;
    expect(result).toMatchObject({ ok: true, result: { operation: "navigate" } });
    expect(target.src).toContain("/next");
    const snapshot = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(snapshot).toMatchObject({ ok: true, result: { operation: "snapshot", snapshot: { title: "Next page", visibleText: "Next Continue", elements: [{ role: "button" }] } } });
    for (let index = 0; index < 205; index += 1) page.body.append(document.createElement("button"));
    const bounded = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(bounded).toMatchObject({ ok: true, result: { operation: "snapshot", snapshot: { elementsTruncation: { truncated: true, originalCount: 206 } } } });
    target.remove();
  });

  it("uses DOM ids as snapshot semantic ids", async () => {
    const target = iframe();
    target.contentDocument!.body.innerHTML = `<button id="save-button">Save</button>`;
    const result = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { snapshot: {
      elements: [{ semanticId: "save-button", role: "button", accessibleName: "Save" }],
    } } });
    target.remove();
  });

  it("reuses a synthetic snapshot semantic id for a native control click", async () => {
    document.body.innerHTML = `<button>Save</button>`;
    const target = document.createElement("iframe");
    target.dataset.threadId = "thread-1";
    target.dataset.tabId = "tab-1";
    document.body.append(target);
    Object.defineProperty(target, "contentDocument", { configurable: true, value: document });
    const page = document;
    const button = page.querySelector("button")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const snapshot = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    const snapshotData = snapshot.ok && snapshot.result.operation === "snapshot" ? snapshot.result.snapshot : null;
    expect(snapshotData).not.toBeNull();
    const semanticId = snapshotData?.elements[0]?.semanticId;
    expect(semanticId).toMatch(/^element-/);
    if (!semanticId) throw new Error("Snapshot did not return a semantic element identity");
    const result = await executeWebInteraction(page, dispatch("click", {
      target: { semanticId }, button: "left", clickCount: 1, timeoutMs: 1_000,
    }), {
      signal: new AbortController().signal,
      deadline: Date.now() + 1_000,
      expectedControlEpoch: 0,
      targetGeneration: 1,
      getControlEpoch: () => 0,
      getTargetGeneration: () => 1,
    });
    expect(result).toMatchObject({ ok: true });
    expect(clicked).toHaveBeenCalledOnce();
    button.remove();
    expect(resolveWebTarget(page, { semanticId })).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    target.remove();
    document.body.innerHTML = "";
  });

  it("scans hostile oversized DOM without whole-document query materialization", async () => {
    const target = iframe();
    const page = target.contentDocument!;
    page.body.innerHTML = `<div>${"x".repeat(100_000)}</div>${"<button>Action</button>".repeat(300)}`;
    vi.spyOn(page, "querySelectorAll").mockImplementation(() => {
      throw new Error("unbounded querySelectorAll");
    });
    const result = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { operation: "snapshot", snapshot: {
      visibleTextTruncation: { truncated: true },
      elementsTruncation: { truncated: true },
    } } });
    target.remove();
  });

  it("bounds empty nested accessible-name traversal", async () => {
    const target = iframe();
    const page = target.contentDocument!;
    const button = page.createElement("button");
    let current: Element = button;
    for (let index = 0; index < 600; index += 1) {
      const child = page.createElement("span");
      current.append(child);
      current = child;
    }
    page.body.replaceChildren(button);
    const childNodesGetter = vi.spyOn(Node.prototype, "childNodes", "get");
    const result = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(childNodesGetter.mock.calls.length).toBeLessThanOrEqual(900);
    expect(result).toMatchObject({ ok: true, result: { operation: "snapshot", snapshot: {
      visibleTextTruncation: { truncated: true },
    } } });
    childNodesGetter.mockRestore();
    target.remove();
  });

  it("keeps semantic names available after earlier DOM visits", async () => {
    const target = iframe();
    const page = target.contentDocument!;
    page.body.innerHTML = `${"<div></div>".repeat(300)}<button>Later</button>`;
    const result = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { operation: "snapshot", snapshot: {
      elements: [{ accessibleName: "Later" }],
    } } });
    target.remove();
  });

  it("excludes hidden, inert, aria-hidden, and non-rendered controls", async () => {
    const target = iframe();
    target.contentDocument!.body.innerHTML = [
      `<button style="display:none">Display hidden</button>`,
      `<div aria-hidden="true"><button>Aria hidden</button></div>`,
      `<div inert><button>Inert</button></div>`,
      `<input type="hidden" value="secret">`,
      `<button>Visible</button>`,
    ].join("");
    const result = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { operation: "snapshot", snapshot: {
      elements: [{ accessibleName: "Visible" }],
    } } });
    target.remove();
  });

  it("does not expose credential autofill values while retaining ordinary input values", async () => {
    const target = iframe();
    target.contentDocument!.body.innerHTML = [
      `<input value="ordinary">`,
      `<input autocomplete="new-password" value="secret-new">`,
      `<input autocomplete="username" value="secret-user">`,
      `<input type="password" value="secret-password">`,
    ].join("");
    const result = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { snapshot: {
      elements: [
        { role: "input", value: "ordinary" },
        { role: "input" },
        { role: "input" },
        { role: "input" },
      ],
    } } });
    const elements = (result as { result?: { snapshot?: { elements?: Array<{ value?: string }> } } }).result?.snapshot?.elements ?? [];
    expect(elements.map((element) => element.value)).toEqual(["ordinary", undefined, undefined, undefined]);
    target.remove();
  });

  it("fails closed when the matching iframe is hidden", async () => {
    const target = iframe();
    target.parentElement?.setAttribute("aria-hidden", "true");
    const result = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "TAB_UNAVAILABLE" } });
    expectTypedFailure(result);
    target.parentElement?.removeAttribute("aria-hidden");
    target.remove();
  });

  it("accepts a hidden iframe only inside the dedicated automation surface", async () => {
    const surface = document.createElement("div");
    surface.dataset.automationPersistentScope = "thread-1";
    surface.setAttribute("aria-hidden", "true");
    surface.setAttribute("inert", "");
    const target = document.createElement("iframe");
    target.dataset.threadId = "thread-1";
    target.dataset.tabId = "web-preview";
    target.src = "about:blank";
    surface.append(target);
    document.body.append(surface);
    const page = document.implementation.createHTMLDocument("Fixture");
    page.title = "Fixture";
    Object.defineProperty(target, "contentDocument", { configurable: true, value: page });
    const openDispatch = dispatch("open", { url: `${window.location.origin}/browser-automation-fixture.html` });
    openDispatch.target = { ...openDispatch.target, tabId: "web-preview" };
    const opening = executeWebBrowserDispatch(
      openDispatch,
      new AbortController().signal,
    );
    window.setTimeout(() => target.dispatchEvent(new Event("load")), 0);
    await expect(opening).resolves.toMatchObject({ ok: true, result: { operation: "open" } });
    surface.remove();
  });

  it("rejects cross-origin navigation and DOM access with a typed error", async () => {
    const target = iframe();
    const rejected = await executeWebBrowserDispatch(dispatch("navigate", { url: "https://other.example/" }), new AbortController().signal);
    expect(rejected).toMatchObject({ ok: false, error: { code: "CROSS_ORIGIN" } });
    expectTypedFailure(rejected);
    Object.defineProperty(target, "contentDocument", { configurable: true, get: () => null });
    const snapshot = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(snapshot).toMatchObject({ ok: false, error: { code: "CROSS_ORIGIN" } });
    expectTypedFailure(snapshot);
    target.remove();
  });

  it("stops before touching the iframe when cancelled or past its deadline", async () => {
    const target = iframe();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), controller.signal);
    expect(cancelled).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    expectTypedFailure(cancelled);
    const expired = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }, Date.now() - 1), new AbortController().signal);
    expect(expired).toMatchObject({ ok: false, error: { code: "DEADLINE_EXCEEDED" } });
    expectTypedFailure(expired);
    target.remove();
  });

  it("captures a bounded screenshot from the visible iframe", async () => {
    const target = iframe();
    vi.mocked(captureVisibleWebScreenshot).mockResolvedValueOnce({
      ok: true,
      value: {
        mediaType: "image/png",
        dataBase64: "AAAA",
        width: 320,
        height: 180,
        truncation: { truncated: false },
      },
    });
    const request = dispatch("screenshot", { maxWidth: 320 });
    const result = await executeWebBrowserDispatch(request, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      result: { operation: "screenshot", screenshot: { mediaType: "image/png", width: 320, height: 180 } },
    });
    expect(captureVisibleWebScreenshot).toHaveBeenCalledWith({
      iframe: target,
      maxWidth: 320,
      deadline: request.request.deadline,
      signal: expect.any(AbortSignal),
    });
    target.remove();
  });

  it("returns mechanical inspect facts without public semantic metadata", async () => {
    const target = iframe();
    const result = await executeWebBrowserDispatch(
      dispatch("inspect", { includeScreenshot: false, includeDiagnostics: true }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: true, result: { operation: "inspect", tabs: [{ tabId: "tab-1" }], snapshot: expect.any(Object) } });
    if (result.ok && result.result.operation === "inspect") {
      expect(result.result).not.toHaveProperty("capabilities");
      expect(result.result).not.toHaveProperty("guidance");
      expect(result.result).not.toHaveProperty("capabilityRevision");
      expect(result.result).not.toHaveProperty("observationRef");
      expect(result.result).not.toHaveProperty("readiness");
    }
    target.remove();
  });

  it("rejects full-page screenshots before capture", async () => {
    const target = iframe();
    vi.mocked(captureVisibleWebScreenshot).mockClear();
    const result = await executeWebBrowserDispatch(
      dispatch("screenshot", { maxWidth: 320, fullPage: true }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_OPERATION" },
    });
    expectTypedFailure(result);
    expect(captureVisibleWebScreenshot).not.toHaveBeenCalled();
    target.remove();
  });
});
