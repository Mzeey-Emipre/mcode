import { describe, expect, it, vi } from "vitest";
import type { BrowserAutomationHostDispatch, BrowserAutomationResponse } from "@mcode/contracts";
import { BrowserSessionDriver, ElectronBrowserSessionAdapter, getBrowserAutomationRuntimeOperations } from "./browserSessionDriver";
import { WebBrowserSessionAdapter } from "./webBrowserSessionAdapter";

const response = {} as BrowserAutomationResponse;
const dispatch = {} as BrowserAutomationHostDispatch;

describe("BrowserSessionDriver", () => {
  function inspectDispatch(requestId = "inspect"): BrowserAutomationHostDispatch {
    return {
      connection: { connectionGeneration: 1, targetGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId: "tab", targetGeneration: 1, windowId: 1 },
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
        operation: "inspect",
        args: { includeScreenshot: false, includeDiagnostics: false },
      },
    } as unknown as BrowserAutomationHostDispatch;
  }

  function evaluateDispatch(
    observationRef: string,
    options: { requestId?: string; deadline?: number; deadlineMs?: number } = {},
  ): BrowserAutomationHostDispatch {
    return {
      connection: { connectionGeneration: 1, targetGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId: "tab", targetGeneration: 1, windowId: 1 },
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId: options.requestId ?? "evaluate",
        sequence: 2,
        deadline: options.deadline ?? Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "evaluate",
        args: {
          idempotencyKey: "evaluate-key",
          observationRef,
          deadlineMs: options.deadlineMs ?? 10_000,
          expression: "document.title",
          awaitPromise: true,
          timeoutMs: 10_000,
        },
      },
    } as unknown as BrowserAutomationHostDispatch;
  }

  it("derives truthful operation sets for each runtime", () => {
    const webOperations = getBrowserAutomationRuntimeOperations("web");
    const electronOperations = getBrowserAutomationRuntimeOperations("electron");
    expect(webOperations).not.toContain("evaluate");
    expect(electronOperations).toContain("evaluate");
    expect(webOperations).toContain("act");
    expect(electronOperations).toContain("inspect");
  });

  it("fails closed for web evaluate without invoking either runtime adapter", async () => {
    const web = vi.fn();
    const electron = vi.fn();
    const driver = new BrowserSessionDriver({
      web: { execute: web },
      electron: { execute: electron },
      isElectron: () => false,
    });
    const result = await driver.execute(evaluateDispatch("missing"), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_OPERATION", effect: "none" } });
    expect(web).not.toHaveBeenCalled();
    expect(electron).not.toHaveBeenCalled();
  });

  it("wraps an Electron raw evaluate success and consumes the observation", async () => {
    const electron = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      if (dispatch.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      return {
        contractVersion: 1,
        requestId: dispatch.request.requestId,
        sequence: dispatch.request.sequence,
        ok: true,
        result: { operation: "evaluate", valueJson: '"title"', controlEpoch: 0 },
      } as BrowserAutomationResponse;
    });
    const web = vi.fn();
    const driver = new BrowserSessionDriver({
      web: { execute: web },
      electron: { execute: electron },
      isElectron: () => true,
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result?: { observationRef?: string } }).result?.observationRef;
    const result = await driver.execute(evaluateDispatch(observationRef!), new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      result: {
        operation: "evaluate",
        outcome: "completed",
        stoppingPosition: 1,
        effect: "complete",
        recovery: "inspect",
        receipts: [{ index: 0, operation: "evaluate", status: "applied" }],
        valueJson: '"title"',
        finalObservation: { observationRevision: 1 },
        nextObservationRef: expect.any(String),
      },
    });
    expect(web).not.toHaveBeenCalled();
    expect(electron).toHaveBeenCalledTimes(2);
    const nextObservationRef = (result as { result?: { nextObservationRef?: string } }).result?.nextObservationRef;
    await expect(driver.execute(evaluateDispatch(observationRef!, { requestId: "replay" }), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: "STALE_TARGET_GENERATION" } });
    expect(nextObservationRef).toEqual(expect.any(String));
  });

  it("returns an interrupted envelope when the Electron adapter cancels", async () => {
    const electron = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      if (dispatch.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      return {
        contractVersion: 1,
        requestId: dispatch.request.requestId,
        sequence: dispatch.request.sequence,
        ok: false,
        error: { code: "OPERATION_CANCELLED", message: "cancelled", retryable: true },
      } as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute: vi.fn() },
      electron: { execute: electron },
      isElectron: () => true,
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const result = await driver.execute(evaluateDispatch(observationRef), new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      result: {
        operation: "evaluate",
        outcome: "interrupted",
        effect: "partial",
        receipts: [{ index: 0, operation: "evaluate", status: "interrupted" }],
        finalObservation: { observationRevision: 1 },
        nextObservationRef: expect.any(String),
      },
    });
  });

  it("bounds the Electron evaluation deadline by deadlineMs", async () => {
    const electron = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      if (dispatch.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      return { ok: true, result: { operation: "evaluate", valueJson: "null", controlEpoch: 0 } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute: vi.fn() },
      electron: { execute: electron },
      isElectron: () => true,
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const startedAt = Date.now();
    const originalDeadline = startedAt + 60_000;
    await driver.execute(evaluateDispatch(observationRef, { deadline: originalDeadline, deadlineMs: 1_000 }), new AbortController().signal);
    const evaluateRequest = electron.mock.calls[1]![0].request;
    expect(evaluateRequest.deadline).toBeLessThan(originalDeadline);
    expect(evaluateRequest.deadline).toBeGreaterThanOrEqual(startedAt + 900);
    expect(evaluateRequest.deadline).toBeLessThanOrEqual(startedAt + 1_100);
  });

  it("stops before Electron evaluate when the live document revision changed", async () => {
    let documentRevision = 1;
    const electron = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      if (dispatch.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      return { ok: true, result: { operation: "evaluate", valueJson: "null", controlEpoch: 0 } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute: vi.fn() },
      electron: { execute: electron },
      isElectron: () => true,
      getDocumentRevision: () => documentRevision,
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    documentRevision = 2;
    const result = await driver.execute(evaluateDispatch(observationRef), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "STALE_TARGET_GENERATION", effect: "none" } });
    expect(electron).toHaveBeenCalledOnce();
  });

  it("stops before Electron evaluate when the request is already aborted", async () => {
    const electron = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      if (dispatch.request.operation === "inspect") return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      return { ok: true, result: { operation: "evaluate", valueJson: "null", controlEpoch: 0 } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute: vi.fn() },
      electron: { execute: electron },
      isElectron: () => true,
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const controller = new AbortController();
    controller.abort(new Error("revoked"));
    const result = await driver.execute(evaluateDispatch(observationRef), controller.signal);
    expect(result).toMatchObject({
      ok: true,
      result: {
        operation: "evaluate",
        outcome: "interrupted",
        effect: "none",
        receipts: [{ index: 0, operation: "evaluate", status: "interrupted" }],
      },
    });
    expect(electron).toHaveBeenCalledOnce();
  });

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

  it("preserves a host-issued observation reference for the next act", async () => {
    const execute = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      if (dispatch.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect", observationRef: "driver-issued" } } as unknown as BrowserAutomationResponse;
      }
      return { ok: true, result: { operation: dispatch.request.operation } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({ web: { execute }, electron: { execute }, isElectron: () => false, supportedActOperations: ["click"] });
    const inspect = await driver.execute({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId: "tab", targetGeneration: 1 },
      request: { contractVersion: 1, requestId: "inspect-issued", sequence: 1, operation: "inspect", expectedControlEpoch: 0 },
    } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(inspect).toMatchObject({ ok: true, result: { observationRef: "driver-issued" } });
    await expect(driver.execute(actDispatch("driver-issued", [{ operation: "click", target: { cssSelector: "#save" } }]), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, result: { outcome: "completed" } });
    expect(execute).toHaveBeenCalledTimes(2);
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
