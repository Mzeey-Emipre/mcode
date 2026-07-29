import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, type BrowserAutomationHostDispatch } from "@mcode/contracts";
import {
  executeWebInteraction,
  observeWebHumanInput,
  resolveWebTarget,
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

  it("observes direct human input", () => {
    const onHumanInput = vi.fn();
    const dispose = observeWebHumanInput(document, onHumanInput);
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onHumanInput).toHaveBeenCalledOnce();
    dispose();
  });
});
