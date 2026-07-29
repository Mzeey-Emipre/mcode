import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, type BrowserAutomationHostDispatch } from "@mcode/contracts";
import {
  executeWebInteraction,
  observeWebHumanInput,
  redactBrowserLocation,
  redactBrowserText,
  resolveWebTarget,
  isTrustedHumanInputEvent,
} from "../webBrowserInteractionExecutor";

function dispatch(operation: "click" | "type", args: Record<string, unknown>): BrowserAutomationHostDispatch {
  return {
    scope: { workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance" },
    connection: { desktopInstanceId: "desktop", windowId: 1, connectionGeneration: 1, targetGeneration: 1 },
    target: { desktopInstanceId: "desktop", windowId: 1, connectionGeneration: 1, threadId: "thread", tabId: "tab", targetGeneration: 1, active: true, focused: true, lastUsedAt: 1 },
    request: {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      workspaceId: "workspace",
      threadId: "thread",
      providerSessionId: "session",
      providerInstanceId: "instance",
      requestId: `request-${operation}`,
      sequence: 1,
      deadline: Date.now() + 10_000,
      expectedControlEpoch: 0,
      operation,
      args,
    } as never,
  };
}

function guard(signal = new AbortController().signal) {
  return {
    signal,
    deadline: Date.now() + 10_000,
    expectedControlEpoch: 0,
    targetGeneration: 1,
    getControlEpoch: () => 0,
    getTargetGeneration: () => 1,
  };
}

describe("web browser interaction executor", () => {
  it("clicks an eligible visible same-origin target", async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const button = document.querySelector("button") as HTMLButtonElement;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const result = await executeWebInteraction(document, dispatch("click", { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 }), guard());
    expect(result.ok).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("uses iframe-realm controls and event constructors for click, type, and submit", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameDocument = frame.contentDocument!;
    frameDocument.body.innerHTML = '<button id="save">Save</button><input id="email" />';
    const button = frameDocument.querySelector("button")!;
    const input = frameDocument.querySelector("input")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const frameView = frameDocument.defaultView!;
    const clickEvent = frameView.MouseEvent;
    const inputEvent = frameView.InputEvent;
    const keyboardEvent = frameView.KeyboardEvent;
    const clicked = vi.fn();
    const typed = vi.fn();
    const submitted = vi.fn();
    button.addEventListener("click", (event) => {
      clicked(event instanceof clickEvent);
    });
    input.addEventListener("input", (event) => {
      typed(event instanceof inputEvent);
    });
    input.addEventListener("keydown", (event) => {
      event.preventDefault();
      submitted(event instanceof keyboardEvent && (event as KeyboardEvent).key === "Enter");
    });

    const clickResult = await executeWebInteraction(
      frameDocument,
      dispatch("click", { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 }),
      guard(),
    );
    const typeResult = await executeWebInteraction(
      frameDocument,
      dispatch("type", { target: { cssSelector: "#email" }, text: "typed", clear: true, submit: true, timeoutMs: 1000 }),
      guard(),
    );

    expect(clickResult.ok).toBe(true);
    expect(typeResult.ok).toBe(true);
    expect(clicked).toHaveBeenCalledWith(true);
    expect(typed).toHaveBeenCalledWith(true);
    expect(submitted).toHaveBeenCalledWith(true);
    expect(input.value).toBe("typed");
  });

  it("submits a native single-line form control once when Enter is not prevented", async () => {
    document.body.innerHTML = '<form id="form"><input id="email" /></form>';
    const form = document.querySelector("form")!;
    const input = document.querySelector("input") as HTMLInputElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
    form.addEventListener("submit", submitted);

    const result = await executeWebInteraction(
      document,
      dispatch("type", { target: { cssSelector: "#email" }, text: "typed", clear: true, submit: true, timeoutMs: 1000 }),
      guard(),
    );

    expect(result.ok).toBe(true);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("does not submit when Enter is prevented and keeps textarea Enter native", async () => {
    document.body.innerHTML = '<form id="form"><input id="email" /><textarea id="notes"></textarea></form>';
    const form = document.querySelector("form")!;
    const input = document.querySelector("input") as HTMLInputElement;
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue({ width: 120, height: 40 } as DOMRect);
    const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
    form.addEventListener("submit", submitted);
    input.addEventListener("keydown", (event) => event.preventDefault());

    await executeWebInteraction(
      document,
      dispatch("type", { target: { cssSelector: "#email" }, text: "typed", clear: true, submit: true, timeoutMs: 1000 }),
      guard(),
    );
    await executeWebInteraction(
      document,
      dispatch("type", { target: { cssSelector: "#notes" }, text: "line", clear: true, submit: true, timeoutMs: 1000 }),
      guard(),
    );

    expect(submitted).not.toHaveBeenCalled();
    expect(textarea.value).toBe("line");
  });

  it("does not submit when the synthetic keypress is prevented", async () => {
    document.body.innerHTML = '<form id="form"><input id="email" /></form>';
    const form = document.querySelector("form")!;
    const input = document.querySelector("input") as HTMLInputElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
    form.addEventListener("submit", submitted);
    input.addEventListener("keypress", (event) => event.preventDefault());

    await executeWebInteraction(
      document,
      dispatch("type", { target: { cssSelector: "#email" }, text: "typed", clear: true, submit: true, timeoutMs: 1000 }),
      guard(),
    );

    expect(submitted).not.toHaveBeenCalled();
  });

  it("rechecks target generation after Enter handlers before submitting", async () => {
    document.body.innerHTML = '<form id="form"><input id="email" /></form>';
    const form = document.querySelector("form")!;
    const input = document.querySelector("input") as HTMLInputElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
    form.addEventListener("submit", submitted);
    let generation = 1;
    const operationGuard = guard();
    operationGuard.getTargetGeneration = () => generation;
    input.addEventListener("keydown", () => {
      generation = 2;
    });

    const result = await executeWebInteraction(
      document,
      dispatch("type", { target: { cssSelector: "#email" }, text: "typed", clear: true, submit: true, timeoutMs: 1000 }),
      operationGuard,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "STALE_TARGET_GENERATION" } });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("submits at most once when a page Enter handler requests submission", async () => {
    document.body.innerHTML = '<form id="form"><input id="email" /></form>';
    const form = document.querySelector("form")!;
    const input = document.querySelector("input") as HTMLInputElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
    form.addEventListener("submit", submitted);
    input.addEventListener("keydown", () => form.requestSubmit());

    const result = await executeWebInteraction(
      document,
      dispatch("type", { target: { cssSelector: "#email" }, text: "typed", clear: true, submit: true, timeoutMs: 1000 }),
      guard(),
    );

    expect(result.ok).toBe(true);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("redacts credential-shaped URL and title metadata while preserving useful identity", async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const button = document.querySelector("button")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 80, height: 20 } as DOMRect);
    Object.defineProperty(document, "title", { configurable: true, value: "Dashboard token: eyJheader.payloadxx.signaturexx" });

    const result = await executeWebInteraction(
      document,
      dispatch("click", { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 }),
      guard(),
    );

    expect(result).toMatchObject({ ok: true, result: { title: "Dashboard token: [REDACTED]" } });
    expect(redactBrowserLocation("https://user:pass@example.test/path?view=home&token=secret#next=ok&access_token=hidden")).toBe("https://example.test/path?view=home&token=%5BREDACTED%5D#next=ok&access_token=%5BREDACTED%5D");
    expect(redactBrowserText("Bearer abc.def password: secret")).toBe("Bearer [REDACTED] password: [REDACTED]");
    expect(redactBrowserText("password: my secret")).toBe("password: [REDACTED]");
    const fragmentToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signature-value";
    expect(redactBrowserLocation(`https://example.test/callback#${fragmentToken}`)).not.toContain(fragmentToken);
    expect(redactBrowserLocation("https://example.test/callback#section-1")).toBe("https://example.test/callback#section-1");
    expect(JSON.stringify(result)).not.toContain("eyJheader.payloadxx.signaturexx");
  });

  it("types into editable controls and never echoes typed text in failures", async () => {
    document.body.innerHTML = '<input id="email" />';
    const input = document.querySelector("input") as HTMLInputElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ width: 120, height: 20 } as DOMRect);
    const secret = "sensitive-value";
    const result = await executeWebInteraction(document, dispatch("type", { target: { cssSelector: "#email" }, text: secret, clear: true, submit: false, timeoutMs: 1000 }), guard());
    expect(result.ok).toBe(true);
    expect(input.value).toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("fails closed for hostile selectors and cancelled work", async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    expect(resolveWebTarget(document, { cssSelector: "[" })).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    const controller = new AbortController();
    controller.abort();
    const result = await executeWebInteraction(document, dispatch("click", { target: { cssSelector: "#save" }, button: "left", clickCount: 1, timeoutMs: 1000 }), guard(controller.signal));
    expect(result).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
  });

  it("ignores untrusted page events but recognizes trusted human input", () => {
    const onHumanInput = vi.fn();
    const dispose = observeWebHumanInput(document, onHumanInput);
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onHumanInput).not.toHaveBeenCalled();
    dispose();
    const trustedDispose = observeWebHumanInput(document, onHumanInput, () => true);
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onHumanInput).toHaveBeenCalledOnce();
    expect(isTrustedHumanInputEvent({ isTrusted: true } as Event)).toBe(true);
    expect(isTrustedHumanInputEvent({ isTrusted: false } as Event)).toBe(false);
    trustedDispose();
  });
});
