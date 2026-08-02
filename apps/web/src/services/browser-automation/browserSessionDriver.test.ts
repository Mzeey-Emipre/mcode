import { describe, expect, it, vi } from "vitest";
import type { BrowserAutomationHostDispatch, BrowserAutomationResponse } from "@mcode/contracts";
import { BrowserSessionDriver, ElectronBrowserSessionAdapter } from "./browserSessionDriver";
import { WebBrowserSessionAdapter } from "./webBrowserSessionAdapter";

const response = {} as BrowserAutomationResponse;
const dispatch = {} as BrowserAutomationHostDispatch;

describe("BrowserSessionDriver", () => {
  function actDispatch(observationRef: string, steps: unknown[], requestId = "act"): BrowserAutomationHostDispatch {
    return {
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId: "tab", targetGeneration: 1 },
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId,
        sequence: 1,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "act",
        args: { idempotencyKey: `${requestId}-key`, observationRef, deadlineMs: 10_000, steps },
      },
    } as unknown as BrowserAutomationHostDispatch;
  }

  it("produces an observation in-driver and stops after a navigation boundary with receipts", async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      calls.push(dispatch.request.operation);
      if (dispatch.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      return { ok: true, result: { operation: dispatch.request.operation } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({ web: { execute }, electron: { execute }, isElectron: () => false, supportedActOperations: ["click", "navigate", "type"] });
    const inspect = await driver.execute({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId: "tab", targetGeneration: 1 },
      request: { contractVersion: 1, requestId: "inspect", sequence: 1, operation: "inspect", expectedControlEpoch: 0 },
    } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    const observationRef = (inspect as { result?: { observationRef?: string } }).result?.observationRef;
    expect(observationRef).toEqual(expect.any(String));
    const result = await driver.execute(actDispatch(observationRef!, [
      { operation: "click", target: { cssSelector: "#save" } },
      { operation: "navigate", url: "https://example.test/next" },
      { operation: "type", text: "secret" },
    ]), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { operation: "act", outcome: "completed", stoppingPosition: 2, effect: "complete", receipts: [
      { index: 0, operation: "click", status: "applied" },
      { index: 1, operation: "navigate", status: "applied" },
      { index: 2, operation: "type", status: "skipped" },
    ] } });
    expect(calls).toEqual(["inspect", "click", "navigate"]);
    const replay = await driver.execute(actDispatch(observationRef!, [{ operation: "click", target: { cssSelector: "#save" } }], "second"), new AbortController().signal);
    expect(replay).toMatchObject({ ok: false, error: { code: "STALE_TARGET_GENERATION" } });
  });

  it("rejects unsupported steps before the first adapter effect", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, result: { operation: "click" } } as unknown as BrowserAutomationResponse);
    const driver = new BrowserSessionDriver({ web: { execute }, electron: { execute }, isElectron: () => false, supportedActOperations: ["click"] });
    const result = await driver.execute(actDispatch("observation", [
      { operation: "click", target: { cssSelector: "#save" } },
      { operation: "type", text: "secret" },
    ]), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_OPERATION", effect: "none" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops before the next effect when control revision changes", async () => {
    let controlRevision = 0;
    const execute = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      if (dispatch.request.operation === "inspect") return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      controlRevision = 1;
      return { ok: true, result: { operation: dispatch.request.operation } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({ web: { execute }, electron: { execute }, isElectron: () => false, getControlRevision: () => controlRevision, supportedActOperations: ["click", "type"] });
    const inspect = await driver.execute({ connection: { connectionGeneration: 1, capabilityRevision: 1 }, target: { threadId: "thread", tabId: "tab", targetGeneration: 1 }, request: { contractVersion: 1, requestId: "inspect", sequence: 1, operation: "inspect", expectedControlEpoch: 0 } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const result = await driver.execute(actDispatch(observationRef, [{ operation: "click", target: { cssSelector: "#save" } }, { operation: "type", text: "secret" }]), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { outcome: "interrupted", effect: "partial", receipts: [{ index: 0, status: "applied" }, { index: 1, status: "interrupted" }] } });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("fails before adapter execution when descriptor revision drifts", async () => {
    const web = vi.fn().mockResolvedValue(response);
    const driver = new BrowserSessionDriver({
      web: { execute: web },
      electron: { execute: web },
      isElectron: () => false,
      getCapabilityRevision: () => 2,
    });
    const result = await driver.execute({
      connection: { capabilityRevision: 1 },
      request: { contractVersion: 1, requestId: "drift", sequence: 1 },
    } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_CHANGED", effect: "none", recovery: "inspect" } });
    expect(web).not.toHaveBeenCalled();
  });

  it("rechecks revision at the last adapter boundary", async () => {
    const web = vi.fn().mockResolvedValue(response);
    let revisionReads = 0;
    const driver = new BrowserSessionDriver({
      web: { execute: web },
      electron: { execute: web },
      isElectron: () => false,
      getCapabilityRevision: () => (++revisionReads === 1 ? 1 : 2),
    });
    const result = await driver.execute({
      connection: { capabilityRevision: 1 },
      request: { contractVersion: 1, requestId: "last-boundary", sequence: 1, operation: "status" },
    } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_CHANGED", effect: "none", recovery: "inspect" } });
    expect(web).not.toHaveBeenCalled();
  });

  it("routes the same command boundary to each runtime adapter", async () => {
    const web = vi.fn().mockResolvedValue(response);
    const electron = vi.fn().mockResolvedValue(response);
    let electronRuntime = false;
    const driver = new BrowserSessionDriver({
      web: { execute: web },
      electron: { execute: electron },
      isElectron: () => electronRuntime,
    });
    const signal = new AbortController().signal;

    await driver.execute(dispatch, signal);
    electronRuntime = true;
    await driver.execute(dispatch, signal);

    expect(web).toHaveBeenCalledWith(dispatch, signal);
    expect(electron).toHaveBeenCalledWith(dispatch, signal);
  });

  it("runs one Browser v1 click case through web and Electron adapter contracts", async () => {
    const webButton = document.createElement("button");
    webButton.id = "save";
    webButton.textContent = "Save";
    document.body.append(webButton);
    Object.defineProperty(webButton, "getBoundingClientRect", { value: () => ({ width: 80, height: 20 }) });
    const webAdapter = new WebBrowserSessionAdapter({
      resolveDocument: () => document,
      resolveSignal: (_dispatch, signal) => signal,
      getControlEpoch: () => 0,
      getTargetGeneration: () => 1,
      onHumanInput: vi.fn(),
      onObserver: (_dispatch, dispose) => dispose,
      executeNonInteraction: vi.fn(),
    });
    const electronExecute = vi.fn().mockResolvedValue({ ok: true } as BrowserAutomationResponse);
    const electronAdapter = new ElectronBrowserSessionAdapter(electronExecute);
    const driver = new BrowserSessionDriver({ web: webAdapter, electron: electronAdapter, isElectron: () => false });
    const clickDispatch = {
      request: { operation: "click", deadline: Date.now() + 1_000, expectedControlEpoch: 0, args: { target: { cssSelector: "#save" }, button: "left", clickCount: 1 } },
      target: { targetGeneration: 1, threadId: "thread", tabId: "tab" },
    } as unknown as BrowserAutomationHostDispatch;
    const webResponse = await driver.execute(clickDispatch, new AbortController().signal);
    expect(webResponse.ok).toBe(true);
    expect(electronExecute).not.toHaveBeenCalled();
    const electronDriver = new BrowserSessionDriver({ web: webAdapter, electron: electronAdapter, isElectron: () => true });
    await electronDriver.execute(clickDispatch, new AbortController().signal);
    expect(electronExecute).toHaveBeenCalledWith(clickDispatch, expect.any(AbortSignal));
    document.body.removeChild(webButton);
  });

  it("joins idempotent opens, returns an observation reference, and rejects conflicts", async () => {
    const execute = vi.fn().mockResolvedValue({
      contractVersion: 1,
      requestId: "first",
      sequence: 1,
      ok: true,
      result: { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
    } as BrowserAutomationResponse);
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
    });
    const makeDispatch = (requestId: string, url: string, targetGeneration = 1, windowId = 1): BrowserAutomationHostDispatch => ({
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId,
        sequence: 1,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "open",
        args: { url, idempotencyKey: "open-key" },
      },
      target: { threadId: "thread", tabId: "tab", windowId, targetGeneration },
    } as unknown as BrowserAutomationHostDispatch);
    const first = await driver.execute(makeDispatch("first", "https://example.test/"), new AbortController().signal);
    const replay = await driver.execute(makeDispatch("replay", "https://example.test/"), new AbortController().signal);
    const conflict = await driver.execute(makeDispatch("conflict", "https://other.test/"), new AbortController().signal);
    expect(execute).toHaveBeenCalledOnce();
    expect(first).toMatchObject({ ok: true, result: { operation: "open", observationRef: expect.any(String) } });
    expect(replay).toMatchObject({ ok: true, requestId: "replay", result: { operation: "open" } });
    expect(conflict).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });

    await driver.execute(makeDispatch("window-bump", "https://example.test/", 1, 2), new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(2);

    await driver.execute(makeDispatch("generation-bump", "https://example.test/", 2), new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(3);

    driver.clearIdempotencyForTarget("thread", "tab");
    await driver.execute(makeDispatch("fresh", "https://example.test/", 2), new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
