import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, type BrowserAutomationHostDispatch } from "@mcode/contracts";
import { captureVisibleWebScreenshot } from "../web-browser-automation/capture";
import { executeWebBrowserDispatch } from "../browserAutomationWebExecutor";

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
    target.parentElement?.removeAttribute("aria-hidden");
    target.remove();
  });

  it("rejects cross-origin navigation and DOM access with a typed error", async () => {
    const target = iframe();
    const rejected = await executeWebBrowserDispatch(dispatch("navigate", { url: "https://other.example/" }), new AbortController().signal);
    expect(rejected).toMatchObject({ ok: false, error: { code: "CROSS_ORIGIN" } });
    Object.defineProperty(target, "contentDocument", { configurable: true, get: () => null });
    const snapshot = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), new AbortController().signal);
    expect(snapshot).toMatchObject({ ok: false, error: { code: "CROSS_ORIGIN" } });
    target.remove();
  });

  it("stops before touching the iframe when cancelled or past its deadline", async () => {
    const target = iframe();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }), controller.signal);
    expect(cancelled).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    const expired = await executeWebBrowserDispatch(dispatch("snapshot", { includeScreenshot: false }, Date.now() - 1), new AbortController().signal);
    expect(expired).toMatchObject({ ok: false, error: { code: "DEADLINE_EXCEEDED" } });
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
});
