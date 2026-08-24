import { describe, expect, it, vi } from "vitest";
import type {
  BrowserAutomationHostDispatch,
  BrowserAutomationHostDispatchTarget,
  BrowserAutomationResponse,
} from "@mcode/contracts";
import { BrowserAutomationResponseSchema } from "@mcode/contracts";
import {
  BrowserSessionDriver,
  ElectronBrowserSessionAdapter,
  getBrowserAutomationRuntimeActOperations,
  getBrowserAutomationRuntimeOperations,
  type BrowserSessionLifecycleTab,
} from "../browserSessionDriver";
import { WebBrowserSessionAdapter } from "../webBrowserSessionAdapter";

const response = {} as BrowserAutomationResponse;
const dispatch = {} as BrowserAutomationHostDispatch;

describe("BrowserSessionDriver", () => {
  function inspectDispatch(requestId = "inspect", workspaceId = "workspace"): BrowserAutomationHostDispatch {
    return {
      connection: { connectionGeneration: 1, targetGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId: "tab", targetGeneration: 1, windowId: 1 },
      request: {
        contractVersion: 1,
        workspaceId,
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

  function browserTarget(tabId: string, lastUsedAt = 1): BrowserAutomationHostDispatchTarget {
    return {
      desktopInstanceId: "desktop",
      threadId: "thread",
      tabId,
      windowId: 1,
      connectionGeneration: 1,
      targetGeneration: 1,
      active: tabId === "tab-2",
      focused: tabId === "tab-2",
      lastUsedAt,
    };
  }

  function openTabDispatch(target: BrowserAutomationHostDispatchTarget, requestId: string, sequence: number): BrowserAutomationHostDispatch {
    return {
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId,
        sequence,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "open",
        args: { idempotencyKey: `${requestId}-key` },
      },
    } as unknown as BrowserAutomationHostDispatch;
  }

  function inspectTabDispatch(target: BrowserAutomationHostDispatchTarget, requestId: string, sequence: number): BrowserAutomationHostDispatch {
    return {
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId,
        sequence,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "inspect",
        args: { includeScreenshot: false, includeDiagnostics: false },
      },
    } as unknown as BrowserAutomationHostDispatch;
  }

  function tabsDispatch(
    target: BrowserAutomationHostDispatchTarget,
    requestId: string,
    sequence: number,
    observationRef: string,
    args: Record<string, unknown>,
  ): BrowserAutomationHostDispatch {
    return {
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId,
        sequence,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "tabs",
        args: {
          idempotencyKey: `${requestId}-key`,
          observationRef,
          ...args,
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

  it("derives truthful act-step mechanics without advertising unsupported steps", () => {
    expect(getBrowserAutomationRuntimeActOperations("electron")).toEqual([
      "navigate",
      "back",
      "forward",
      "reload",
      "wait",
      "click",
      "type",
      "press",
      "scroll",
    ]);
    expect(getBrowserAutomationRuntimeActOperations("electron")).not.toEqual(expect.arrayContaining([
      "hover",
      "drag",
      "resize",
      "recordingStart",
      "recordingStop",
    ]));
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

  it("rejects a deferred Electron evaluation when capability revision changes before completion", async () => {
    let revision = 1;
    let resolveEvaluate!: (response: BrowserAutomationResponse) => void;
    const deferredEvaluate = new Promise<BrowserAutomationResponse>((resolve) => {
      resolveEvaluate = resolve;
    });
    const electron = vi.fn((value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "inspect") {
        return Promise.resolve({ ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse);
      }
      return deferredEvaluate;
    });
    const driver = new BrowserSessionDriver({
      web: { execute: vi.fn() },
      electron: { execute: electron },
      isElectron: () => true,
      getCapabilityRevision: () => revision,
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const pending = driver.execute(evaluateDispatch(observationRef), new AbortController().signal);
    await Promise.resolve();
    revision = 2;
    resolveEvaluate({
      ok: true,
      result: { operation: "evaluate", valueJson: '"private"', controlEpoch: 0 },
    } as unknown as BrowserAutomationResponse);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_CHANGED", effect: "none", recovery: "inspect" },
    });
    expect(JSON.stringify(await pending)).not.toContain("private");
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

  it("cancels an in-flight wait and skips later act steps", async () => {
    const calls: string[] = [];
    const execute = vi.fn((dispatch: BrowserAutomationHostDispatch, signal: AbortSignal) => {
      calls.push(dispatch.request.operation);
      if (dispatch.request.operation === "inspect") {
        return Promise.resolve({ ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse);
      }
      if (dispatch.request.operation === "wait") {
        return new Promise<BrowserAutomationResponse>((resolve) => {
          signal.addEventListener("abort", () => resolve({
            ok: false,
            error: {
              code: "OPERATION_CANCELLED",
              message: "Browser wait was cancelled",
              retryable: true,
              stage: "effect",
              effect: "none",
              recovery: "inspect",
            },
          } as BrowserAutomationResponse), { once: true });
        });
      }
      return Promise.resolve({ ok: true, result: { operation: dispatch.request.operation } } as unknown as BrowserAutomationResponse);
    });
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      supportedActOperations: ["wait", "click"],
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const controller = new AbortController();
    const pending = driver.execute(actDispatch(observationRef, [
      { operation: "wait", durationMs: 10_000 },
      { operation: "click", target: { cssSelector: "#after-wait" } },
    ], "wait-cancel"), controller.signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: {
        outcome: "interrupted",
        effect: "none",
        receipts: [
          { index: 0, operation: "wait", status: "interrupted" },
          { index: 1, operation: "click", status: "skipped" },
        ],
      },
    });
    expect(calls).toEqual(["inspect", "wait"]);
  });

  it("stops an act batch at a reload document boundary", async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => {
      calls.push(dispatch.request.operation);
      if (dispatch.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      return { ok: true, result: { operation: dispatch.request.operation } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      supportedActOperations: ["reload", "click"],
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const result = await driver.execute(actDispatch(observationRef, [
      { operation: "reload" },
      { operation: "click", target: { cssSelector: "#after-reload" } },
    ], "reload-boundary"), new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      result: {
        outcome: "completed",
        stoppingPosition: 1,
        effect: "complete",
        receipts: [
          { index: 0, operation: "reload", status: "applied" },
          { index: 1, operation: "click", status: "skipped" },
        ],
      },
    });
    expect(calls).toEqual(["inspect", "reload"]);
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

  it("executes an assert step through bounded wait conditions", async () => {
    const execute = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => ({
      ok: true,
      result: { operation: dispatch.request.operation },
    }) as unknown as BrowserAutomationResponse);
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      supportedActOperations: ["click"],
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;

    const result = await driver.execute(actDispatch(observationRef, [{
      operation: "assert",
      target: { cssSelector: "#status" },
      text: "Action status: complete",
    }]), new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      result: { receipts: [{ operation: "assert", status: "satisfied" }] },
    });
    expect(execute.mock.calls.slice(1).map(([dispatch]) => ({
      operation: dispatch.request.operation,
      args: dispatch.request.args,
    }))).toEqual([
      expect.objectContaining({ operation: "waitFor", args: expect.objectContaining({ target: { cssSelector: "#status" }, state: "visible" }) }),
      expect.objectContaining({ operation: "waitFor", args: expect.objectContaining({ text: "Action status: complete" }) }),
    ]);
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

  it("cooperatively stops an act batch after trusted human input invalidates its target", async () => {
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      driver.invalidateTargetObservations("workspace", "thread", "tab");
      return { ok: true, result: { operation: value.request.operation } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      supportedActOperations: ["click", "type"],
    });
    const inspect = await driver.execute(inspectDispatch(), new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const result = await driver.execute(actDispatch(observationRef, [
      { operation: "click", target: { cssSelector: "#save" } },
      { operation: "type", text: "human-safe" },
    ]), new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      result: {
        outcome: "interrupted",
        effect: "partial",
        receipts: [
          { index: 0, operation: "click", status: "applied" },
          { index: 1, operation: "type", status: "interrupted" },
        ],
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("clears invalidation state for a read-only target when its provider session ends", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      result: { operation: "inspect" },
    } as unknown as BrowserAutomationResponse);
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
    });

    await driver.execute(inspectDispatch(), new AbortController().signal);
    driver.invalidateTargetObservations("workspace", "thread", "tab");
    const interactionRevisions = (
      driver as unknown as { humanInteractionRevisions: Map<string, number> }
    ).humanInteractionRevisions;
    expect(interactionRevisions.size).toBe(1);

    await driver.releaseProviderSession("session");

    expect(interactionRevisions.size).toBe(0);
  });

  it("isolates same thread and tab IDs across workspaces during invalidation and cleanup", async () => {
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "inspect") {
        return { ok: true, result: { operation: "inspect" } } as unknown as BrowserAutomationResponse;
      }
      return { ok: true, result: { operation: value.request.operation } } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      supportedActOperations: ["click"],
    });
    const workspaceDispatch = (workspaceId: string): BrowserAutomationHostDispatch => {
      return inspectDispatch("inspect", workspaceId);
    };
    const workspaceAct = (workspaceId: string, observationRef: string): BrowserAutomationHostDispatch => {
      const base = actDispatch(observationRef, [{ operation: "click", target: { cssSelector: "#save" } }]);
      return { ...base, request: { ...base.request, workspaceId } } as BrowserAutomationHostDispatch;
    };
    const inspectA = await driver.execute(workspaceDispatch("workspace-a"), new AbortController().signal);
    const inspectB = await driver.execute(workspaceDispatch("workspace-b"), new AbortController().signal);
    const observationA = (inspectA as { result: { observationRef: string } }).result.observationRef;
    const observationB = (inspectB as { result: { observationRef: string } }).result.observationRef;

    driver.invalidateTargetObservations("workspace-a", "thread", "tab");
    await expect(driver.execute(workspaceAct("workspace-b", observationB), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, result: { outcome: "completed" } });
    await expect(driver.execute(workspaceAct("workspace-a", observationA), new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: "STALE_TARGET_GENERATION" } });

    const openDispatch = (workspaceId: string, requestId: string): BrowserAutomationHostDispatch => ({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId: "tab", windowId: 1, targetGeneration: 1 },
      request: {
        contractVersion: 1,
        workspaceId,
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId,
        sequence: 1,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "open",
        args: { idempotencyKey: "same-open-key" },
      },
    } as unknown as BrowserAutomationHostDispatch);
    await driver.execute(openDispatch("workspace-a", "open-a"), new AbortController().signal);
    await driver.execute(openDispatch("workspace-b", "open-b"), new AbortController().signal);
    const callsAfterInitialOpens = execute.mock.calls.length;
    driver.clearIdempotencyForTarget("workspace-a", "thread", "tab");
    await driver.execute(openDispatch("workspace-b", "open-b-replay"), new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(callsAfterInitialOpens);
    await driver.execute(openDispatch("workspace-a", "open-a-fresh"), new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(callsAfterInitialOpens + 1);
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

  it("runs one Browser v2 click case through web and Electron adapter contracts", async () => {
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

    driver.clearIdempotencyForTarget("workspace", "thread", "tab");
    await driver.execute(makeDispatch("fresh", "https://example.test/", 2), new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("serializes fresh opens with browser_tabs at the driver boundary", async () => {
    let resolveFirst!: (response: BrowserAutomationResponse) => void;
    const firstResponse = new Promise<BrowserAutomationResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const success = {
      contractVersion: 1,
      requestId: "open",
      sequence: 1,
      ok: true,
      result: { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
    } as BrowserAutomationResponse;
    const execute = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(success);
    const driver = new BrowserSessionDriver({ web: { execute }, electron: { execute }, isElectron: () => false });
    const open = (requestId: string, tabId: string, idempotencyKey: string) => ({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId, windowId: 1, connectionGeneration: 1, targetGeneration: 1 },
      request: {
        contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
        requestId, sequence: 1, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "open", args: { idempotencyKey },
      },
    }) as BrowserAutomationHostDispatch;
    const first = driver.execute(open("first-open", "tab-1", "key-1"), new AbortController().signal);
    const concurrentOpen = await driver.execute(open("second-open", "tab-2", "key-2"), new AbortController().signal);
    const concurrentTabs = await driver.execute({ ...open("tabs", "tab-1", "tabs-key"), request: {
      ...open("tabs", "tab-1", "tabs-key").request,
      operation: "tabs",
      args: { action: "close", idempotencyKey: "tabs-key", observationRef: "unobserved" },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(concurrentOpen).toMatchObject({ ok: false, error: { code: "BROWSER_BUSY" } });
    expect(concurrentTabs).toMatchObject({ ok: false, error: { code: "BROWSER_BUSY" } });
    expect(execute).toHaveBeenCalledOnce();
    resolveFirst(success);
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(driver.execute(open("third-open", "tab-3", "key-3"), new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("stops a tab close when cancellation arrives during lifecycle enumeration", async () => {
    const target: BrowserAutomationHostDispatchTarget = {
      desktopInstanceId: "desktop",
      threadId: "thread",
      tabId: "agent-tab",
      windowId: 1,
      connectionGeneration: 1,
      targetGeneration: 1,
      active: true,
      focused: true,
      lastUsedAt: 1,
    };
    let resolveList!: (targets: readonly BrowserAutomationHostDispatchTarget[]) => void;
    const list = vi.fn(() => new Promise<readonly BrowserAutomationHostDispatchTarget[]>((resolve) => {
      resolveList = resolve;
    }));
    const close = vi.fn();
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: 1,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: value.request.operation === "inspect"
        ? { operation: "inspect", tabs: [target] }
        : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
    }) as unknown as BrowserAutomationResponse);
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list, close },
    });
    const opened = await driver.execute({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId: "open",
        sequence: 1,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "open",
        args: { idempotencyKey: "open-key" },
      },
    } as BrowserAutomationHostDispatch, new AbortController().signal);
    const observationRef = (opened as { result: { observationRef: string } }).result.observationRef;
    const controller = new AbortController();
    const pending = driver.execute({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId: "close",
        sequence: 2,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "tabs",
        args: { action: "close", tabId: "agent-tab", idempotencyKey: "close-key", observationRef },
      },
    } as unknown as BrowserAutomationHostDispatch, controller.signal);
    expect(list).toHaveBeenCalledOnce();
    controller.abort();
    resolveList([target]);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "OPERATION_CANCELLED", effect: "none", recovery: "inspect" },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("reconciles the current tab after close completes before cancellation", async () => {
    const tab1 = browserTarget("tab-1");
    const tab2 = browserTarget("tab-2", 2);
    const liveTargets = new Map([[tab1.tabId, tab1], [tab2.tabId, tab2]]);
    let resolveClose!: () => void;
    const close = vi.fn((target: BrowserAutomationHostDispatchTarget) => new Promise<void>((resolve) => {
      resolveClose = () => {
        liveTargets.delete(target.tabId);
        resolve();
      };
    }));
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close },
    });
    await driver.execute(openTabDispatch(tab1, "open-1", 1), new AbortController().signal);
    await driver.execute(openTabDispatch(tab2, "open-2", 2), new AbortController().signal);
    const inspected = await driver.execute(inspectTabDispatch(tab1, "inspect", 3), new AbortController().signal);
    const inspectedRef = (inspected as { result: { observationRef: string } }).result.observationRef;
    const selected = await driver.execute(tabsDispatch(tab1, "select", 4, inspectedRef, { action: "select", tabId: "tab-1" }), new AbortController().signal);
    const selectedRef = (selected as { result: { observationRef: string } }).result.observationRef;
    const controller = new AbortController();
    const closeDispatch = tabsDispatch(tab1, "close", 5, selectedRef, { action: "close", tabId: "tab-1" });
    const pending = driver.execute(closeDispatch, controller.signal);
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    controller.abort();
    resolveClose();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "OPERATION_CANCELLED", effect: "closed", recovery: "inspect" },
    });
    const refreshed = await driver.execute(inspectTabDispatch(tab2, "refresh", 6), new AbortController().signal);
    const refreshedRef = (refreshed as { result: { observationRef: string } }).result.observationRef;
    const released = await driver.execute(tabsDispatch(tab2, "release", 7, refreshedRef, { action: "release", tabId: "tab-2" }), new AbortController().signal);
    expect(released).toMatchObject({
      ok: true,
      result: { tabs: [{ tabId: "tab-2", ownership: "released", disposition: "release" }] },
    });
    expect((released as { result: { currentTabId?: string } }).result.currentTabId).toBeUndefined();
  });

  it("preserves remaining ownership when finalization is cancelled after a close", async () => {
    const tab1 = browserTarget("tab-1");
    const tab2 = browserTarget("tab-2", 2);
    const liveTargets = new Map([[tab1.tabId, tab1], [tab2.tabId, tab2]]);
    let resolveFirstClose!: () => void;
    const close = vi.fn((target: BrowserAutomationHostDispatchTarget) => {
      if (target.tabId === "tab-1") {
        return new Promise<void>((resolve) => {
          resolveFirstClose = () => {
            liveTargets.delete(target.tabId);
            resolve();
          };
        });
      }
      liveTargets.delete(target.tabId);
      return Promise.resolve();
    });
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close },
    });
    await driver.execute(openTabDispatch(tab1, "open-1", 1), new AbortController().signal);
    await driver.execute(openTabDispatch(tab2, "open-2", 2), new AbortController().signal);
    const inspected = await driver.execute(inspectTabDispatch(tab1, "inspect", 3), new AbortController().signal);
    const inspectedRef = (inspected as { result: { observationRef: string } }).result.observationRef;
    const selected = await driver.execute(tabsDispatch(tab1, "select", 4, inspectedRef, { action: "select", tabId: "tab-1" }), new AbortController().signal);
    const selectedRef = (selected as { result: { observationRef: string } }).result.observationRef;
    const controller = new AbortController();
    const finalizeDispatch = tabsDispatch(tab1, "finalize", 5, selectedRef, {
      action: "finalize",
      dispositions: [
        { tabId: "tab-1", disposition: "close" },
        { tabId: "tab-2", disposition: "close" },
      ],
    });
    const pending = driver.execute(finalizeDispatch, controller.signal);
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    controller.abort();
    resolveFirstClose();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "OPERATION_CANCELLED", effect: "closed", recovery: "inspect" },
    });
    const refreshed = await driver.execute(inspectTabDispatch(tab2, "refresh", 6), new AbortController().signal);
    const refreshedRef = (refreshed as { result: { observationRef: string } }).result.observationRef;
    const released = await driver.execute(tabsDispatch(tab2, "release", 7, refreshedRef, { action: "release", tabId: "tab-2" }), new AbortController().signal);
    expect(released).toMatchObject({
      ok: true,
      result: { tabs: [{ tabId: "tab-2", ownership: "released", disposition: "release" }] },
    });
    expect((released as { result: { currentTabId?: string } }).result.currentTabId).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns a truthful envelope when tab close rejects and preserves the controlled state", async () => {
    const target = browserTarget("tab-1");
    const liveTargets = new Map([[target.tabId, target]]);
    const close = vi.fn()
      .mockRejectedValueOnce(new Error("close failed token=topsecret"))
      .mockImplementation(async (value: BrowserAutomationHostDispatchTarget) => {
        liveTargets.delete(value.tabId);
      });
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as unknown as BrowserAutomationResponse;
    });
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close },
    });
    await driver.execute(openTabDispatch(target, "open", 1), new AbortController().signal);
    const inspected = await driver.execute(inspectTabDispatch(target, "inspect", 2), new AbortController().signal);
    const inspectedRef = (inspected as { result: { observationRef: string } }).result.observationRef;
    const failed = await driver.execute(tabsDispatch(target, "close", 3, inspectedRef, { action: "close", tabId: "tab-1" }), new AbortController().signal);
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "TAB_UNAVAILABLE",
        retryable: true,
        stage: "effect",
        effect: "preserved",
        recovery: "inspect",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("topsecret");
    const refreshed = await driver.execute(inspectTabDispatch(target, "refresh", 4), new AbortController().signal);
    const refreshedRef = (refreshed as { result: { observationRef: string } }).result.observationRef;
    const retried = await driver.execute(tabsDispatch(target, "retry-close", 5, refreshedRef, { action: "close", tabId: "tab-1" }), new AbortController().signal);
    expect(retried).toMatchObject({ ok: true, result: { tabs: [] } });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves ownership when tab close resolves but reconciliation retains the target", async () => {
    const target = browserTarget("tab-1");
    const liveTargets = new Map([[target.tabId, target]]);
    const close = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async (value: BrowserAutomationHostDispatchTarget) => {
        liveTargets.delete(value.tabId);
      });
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as unknown as BrowserAutomationResponse;
    });
    const projections: BrowserSessionLifecycleTab[][] = [];
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close },
      onLifecycleChange: (tabs) => projections.push([...tabs]),
    });
    await driver.execute(openTabDispatch(target, "open", 1), new AbortController().signal);
    const inspected = BrowserAutomationResponseSchema().parse(
      await driver.execute(inspectTabDispatch(target, "inspect", 2), new AbortController().signal),
    );
    const inspectedRef = inspected.ok && inspected.result.operation === "inspect" ? inspected.result.observationRef! : "";
    const retained = BrowserAutomationResponseSchema().parse(
      await driver.execute(tabsDispatch(target, "close", 3, inspectedRef, { action: "close", tabId: target.tabId }), new AbortController().signal),
    );
    expect(retained).toMatchObject({ ok: false, error: { code: "TAB_UNAVAILABLE", effect: "preserved", retryable: true } });
    expect(projections.at(-1)).toEqual([expect.objectContaining({ tabId: target.tabId, ownership: "owned" })]);

    const refreshed = BrowserAutomationResponseSchema().parse(
      await driver.execute(inspectTabDispatch(target, "refresh", 4), new AbortController().signal),
    );
    const refreshedRef = refreshed.ok && refreshed.result.operation === "inspect" ? refreshed.result.observationRef! : "";
    const closed = BrowserAutomationResponseSchema().parse(
      await driver.execute(tabsDispatch(target, "retry-close", 5, refreshedRef, { action: "close", tabId: target.tabId }), new AbortController().signal),
    );
    expect(closed).toMatchObject({ ok: true, result: { tabs: [] } });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not adopt a same-tab replacement generation after close", async () => {
    const target = browserTarget("tab-1");
    const replacement = { ...target, targetGeneration: target.targetGeneration + 1 };
    const liveTargets = new Map([[target.tabId, target]]);
    const close = vi.fn(async (value: BrowserAutomationHostDispatchTarget) => {
      liveTargets.set(value.tabId, replacement);
    });
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as unknown as BrowserAutomationResponse;
    });
    const projections: BrowserSessionLifecycleTab[][] = [];
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close },
      onLifecycleChange: (tabs) => projections.push([...tabs]),
    });
    await driver.execute(openTabDispatch(target, "open", 1), new AbortController().signal);
    const inspected = await driver.execute(inspectTabDispatch(target, "inspect", 2), new AbortController().signal);
    const observationRef = (inspected as { result: { observationRef: string } }).result.observationRef;
    const closed = await driver.execute(
      tabsDispatch(target, "close", 3, observationRef, { action: "close", tabId: target.tabId }),
      new AbortController().signal,
    );
    expect(closed).toMatchObject({ ok: true, result: { tabs: [] } });
    expect(projections.at(-1)).toEqual([]);
    await driver.releaseProviderSession("session");
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains agent ownership for provider-session cleanup retry after close failure", async () => {
    const target = browserTarget("tab-1");
    const liveTargets = new Map([[target.tabId, target]]);
    const close = vi.fn()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockImplementation(async (value: BrowserAutomationHostDispatchTarget) => {
        liveTargets.delete(value.tabId);
      });
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as unknown as BrowserAutomationResponse;
    });
    const projections: BrowserSessionLifecycleTab[][] = [];
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close },
      onLifecycleChange: (tabs) => projections.push([...tabs]),
    });
    await driver.execute(openTabDispatch(target, "open", 1), new AbortController().signal);
    await driver.releaseProviderSession("session");
    expect(projections.at(-1)).toEqual([expect.objectContaining({ tabId: target.tabId, ownership: "owned" })]);
    expect(close).toHaveBeenCalledOnce();

    await driver.releaseProviderSession("session");
    expect(projections.at(-1)).toEqual([]);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("drops a retained session when provider cleanup sees a late replacement generation", async () => {
    const target = browserTarget("tab-1");
    const replacement = { ...target, targetGeneration: target.targetGeneration + 1 };
    const liveTargets = new Map([[target.tabId, target]]);
    const close = vi.fn(async (value: BrowserAutomationHostDispatchTarget) => {
      liveTargets.set(value.tabId, replacement);
    });
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as unknown as BrowserAutomationResponse;
    });
    const projections: BrowserSessionLifecycleTab[][] = [];
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close },
      onLifecycleChange: (tabs) => projections.push([...tabs]),
    });
    await driver.execute(openTabDispatch(target, "open", 1), new AbortController().signal);
    await driver.releaseProviderSession("session");
    expect(projections.at(-1)).toEqual([]);
    await driver.releaseProviderSession("session");
    expect(close).toHaveBeenCalledOnce();
    expect(liveTargets.get(target.tabId)).toEqual(replacement);
  });

  it("claims and releases user tabs without physically closing them", async () => {
    const current = { threadId: "thread", tabId: "agent-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 1 };
    const user = { threadId: "thread", tabId: "user-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 4 };
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: 1,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: value.request.operation === "inspect"
        ? { operation: "inspect", tabs: [current, user] }
        : { operation: value.request.operation, url: "about:blank", title: "", controlEpoch: 0 },
    }) as BrowserAutomationResponse);
    const close = vi.fn();
    const driver = new BrowserSessionDriver({
      web: { execute }, electron: { execute }, isElectron: () => false,
      webTabs: { list: async () => [current, user] as never, close },
    });
    const base = {
      scope: { workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance" },
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: current,
    };
    const inspect = await driver.execute({ ...base, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "inspect-tabs", sequence: 1, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const claimDispatch = { ...base, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "claim", sequence: 2, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "tabs",
      args: { action: "claim", tabId: "user-tab", idempotencyKey: "claim-key", observationRef },
    } } as BrowserAutomationHostDispatch;
    const claim = await driver.execute(claimDispatch, new AbortController().signal);
    expect(claim).toMatchObject({ ok: true, result: { operation: "tabs", currentTabId: "user-tab", tabs: [{ tabId: "user-tab", provenance: "claimed-user", ownership: "claimed" }] } });
    expect(driver.responseTarget(claimDispatch, claim)).toMatchObject({ tabId: "user-tab", targetGeneration: 4 });
    const nextObservationRef = (claim as { result: { observationRef: string } }).result.observationRef;
    const closed = await driver.execute({ ...base, target: user, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "close-user", sequence: 3, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "tabs",
      args: { action: "close", idempotencyKey: "close-user-key", observationRef: nextObservationRef },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(closed).toMatchObject({ ok: true, result: { tabs: [{ tabId: "user-tab", ownership: "released", disposition: "release" }] } });
    expect(close).not.toHaveBeenCalled();
  });

  it("implicitly claims a user tab after internal navigation and leaves it open during release", async () => {
    const agent = { threadId: "thread", tabId: "agent-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 1 };
    const user = { threadId: "thread", tabId: "user-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 4 };
    const liveTargets = new Map([[agent.tabId, agent], [user.tabId, user]]);
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: 1,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: { operation: value.request.operation },
    }) as BrowserAutomationResponse);
    const close = vi.fn(async (target: BrowserAutomationHostDispatchTarget) => {
      liveTargets.delete(target.tabId);
    });
    const projections: BrowserSessionLifecycleTab[][] = [];
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()] as never, close },
      onLifecycleChange: (tabs) => projections.push([...tabs]),
    });
    const open = await driver.execute({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: agent,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId: "open-agent",
        sequence: 1,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "open",
        args: { idempotencyKey: "open-agent-key" },
      },
    } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(open).toMatchObject({ ok: true });

    const navigateAgent = await driver.execute({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: agent,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId: "navigate-agent",
        sequence: 2,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "navigate",
        args: { url: "https://example.test/agent" },
      },
    } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(navigateAgent).toMatchObject({ ok: true, result: { operation: "navigate" } });
    expect(projections.at(-1)).toEqual([
      expect.objectContaining({ tabId: "agent-tab", provenance: "agent-created", ownership: "owned" }),
    ]);

    const navigate = await driver.execute({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: user,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        requestId: "navigate-user",
        sequence: 3,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
        operation: "navigate",
        args: { url: "https://example.test/preview" },
      },
    } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(navigate).toMatchObject({ ok: true, result: { operation: "navigate" } });
    expect(projections.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: "agent-tab", provenance: "agent-created", ownership: "owned" }),
      expect.objectContaining({ tabId: "user-tab", provenance: "claimed-user", ownership: "claimed" }),
    ]));

    driver.invalidateTargetObservations("workspace", "thread", "agent-tab");
    driver.invalidateTargetObservations("workspace", "thread", "user-tab");
    const interactionRevisions = (
      driver as unknown as { humanInteractionRevisions: Map<string, number> }
    ).humanInteractionRevisions;
    expect(interactionRevisions.size).toBe(2);

    await driver.releaseProviderSession("session");
    expect(close).toHaveBeenCalledWith(agent, "workspace");
    expect(close).not.toHaveBeenCalledWith(user, "workspace");
    expect(projections.at(-1)).toEqual([]);
    expect(interactionRevisions.size).toBe(0);
  });

  it("does not claim a target when a control operation fails or an observation is read-only", async () => {
    const user = { threadId: "thread", tabId: "user-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 4 };
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "navigate") {
        return {
          contractVersion: 1,
          requestId: value.request.requestId,
          sequence: value.request.sequence,
          ok: false,
          error: { code: "OPERATION_FAILED", message: "navigation failed", retryable: false, stage: "execution", effect: "none", recovery: "inspect" },
        } as unknown as BrowserAutomationResponse;
      }
      return {
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: { operation: value.request.operation },
      } as unknown as BrowserAutomationResponse;
    });
    const projections: BrowserSessionLifecycleTab[][] = [];
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: { list: async () => [user] as never, close: vi.fn() },
      onLifecycleChange: (tabs) => projections.push([...tabs]),
    });
    const base = {
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: user,
      request: {
        contractVersion: 1,
        workspaceId: "workspace",
        threadId: "thread",
        providerSessionId: "session",
        providerInstanceId: "instance",
        sequence: 1,
        deadline: Date.now() + 10_000,
        expectedControlEpoch: 0,
      },
    };
    const failed = await driver.execute({ ...base, request: { ...base.request, requestId: "navigate-failed", operation: "navigate", args: { url: "https://example.test/failed" } } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    const observed = await driver.execute({ ...base, request: { ...base.request, requestId: "inspect-read-only", operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    const recording = await driver.execute({ ...base, request: { ...base.request, requestId: "recording-read-only", operation: "recordingStart", args: {} } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(failed).toMatchObject({ ok: false, error: { code: "OPERATION_FAILED" } });
    expect(observed).toMatchObject({ ok: true, result: { operation: "inspect" } });
    expect(recording).toMatchObject({ ok: true, result: { operation: "recordingStart" } });
    expect(projections).toEqual([]);
  });

  it("publishes lifecycle projection changes for agent-owned and claimed tabs", async () => {
    const current = { threadId: "thread", tabId: "agent-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 1 };
    const user = { threadId: "thread", tabId: "user-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 4 };
    const liveTargets = new Map([[current.tabId, current], [user.tabId, user]]);
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => ({
      contractVersion: 1,
      requestId: value.request.requestId,
      sequence: value.request.sequence,
      ok: true,
      result: value.request.operation === "inspect"
        ? { operation: "inspect", tabs: [current, user] }
        : { operation: value.request.operation, url: "about:blank", title: "", controlEpoch: 0 },
    }) as BrowserAutomationResponse);
    const projections: BrowserSessionLifecycleTab[][] = [];
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: {
        list: async () => [...liveTargets.values()] as never,
        close: vi.fn(async (target: BrowserAutomationHostDispatchTarget) => { liveTargets.delete(target.tabId); }),
      },
      onLifecycleChange: (tabs) => projections.push([...tabs]),
    });
    const base = {
      scope: { workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance" },
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: current,
    };
    const open = await driver.execute({ ...base, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "open", sequence: 1, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "open", args: { idempotencyKey: "open-key" },
    } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(open).toMatchObject({ ok: true });
    expect(projections.at(-1)).toEqual([
      expect.objectContaining({ workspaceId: "workspace", threadId: "thread", tabId: "agent-tab", provenance: "agent-created", ownership: "owned" }),
    ]);

    const inspect = await driver.execute({ ...base, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "inspect", sequence: 2, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false },
    } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const claim = await driver.execute({ ...base, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "claim", sequence: 3, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "tabs",
      args: { action: "claim", tabId: "user-tab", idempotencyKey: "claim-key", observationRef },
    } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(claim).toMatchObject({ ok: true });
    expect(projections.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: "user-tab", provenance: "claimed-user", ownership: "claimed" }),
    ]));

    const inspectAgain = await driver.execute({ ...base, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "inspect-again", sequence: 4, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false },
    } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    const claimedObservationRef = (inspectAgain as { result: { observationRef: string } }).result.observationRef;
    await driver.execute({ ...base, request: {
      contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
      requestId: "release", sequence: 5, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "tabs",
      args: { action: "release", tabId: "user-tab", idempotencyKey: "release-key", observationRef: claimedObservationRef },
    } } as unknown as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(projections.at(-1)?.some((tab) => tab.tabId === "user-tab")).toBe(false);

    await driver.releaseProviderSession("session");
    expect(projections.at(-1)).toEqual([]);
  });

  it("closes omitted agent tabs, preserves deliverables, and activates handoffs", async () => {
    const liveTargets = new Map<string, BrowserAutomationHostDispatch["target"]>();
    const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => {
      if (value.request.operation === "open") liveTargets.set(value.target.tabId, value.target);
      return {
        contractVersion: 1, requestId: value.request.requestId, sequence: value.request.sequence, ok: true,
        result: value.request.operation === "inspect"
          ? { operation: "inspect", tabs: [...liveTargets.values()] }
          : { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      } as BrowserAutomationResponse;
    });
    const close = vi.fn(async (target: BrowserAutomationHostDispatchTarget) => {
      liveTargets.delete(target.tabId);
    });
    const activate = vi.fn(async () => undefined);
    const driver = new BrowserSessionDriver({
      web: { execute }, electron: { execute }, isElectron: () => false,
      webTabs: { list: async () => [...liveTargets.values()], close, activate },
    });
    const open = (tabId: string, key: string) => ({
      connection: { connectionGeneration: 1, capabilityRevision: 1 },
      target: { threadId: "thread", tabId, windowId: 1, connectionGeneration: 1, targetGeneration: 1 },
      request: { contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance", requestId: key, sequence: 1, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "open", args: { idempotencyKey: key } },
    }) as BrowserAutomationHostDispatch;
    await driver.execute(open("tab-1", "open-1"), new AbortController().signal);
    await driver.execute(open("tab-2", "open-2"), new AbortController().signal);
    await driver.execute(open("tab-3", "open-3"), new AbortController().signal);
    const fourth = await driver.execute(open("tab-4", "open-4"), new AbortController().signal);
    expect(fourth).toMatchObject({ ok: false, error: { code: "BROWSER_BUSY" } });
    const inspect = await driver.execute({ ...open("tab-1", "inspect"), request: {
      ...open("tab-1", "inspect").request,
      operation: "inspect",
      args: { includeScreenshot: false, includeDiagnostics: false },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    const observationRef = (inspect as { result: { observationRef: string } }).result.observationRef;
    const claimed = await driver.execute({ ...open("tab-1", "claim-agent"), request: {
      ...open("tab-1", "claim-agent").request,
      operation: "tabs",
      args: { action: "claim", tabId: "tab-1", idempotencyKey: "claim-agent-key", observationRef },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(claimed).toMatchObject({ ok: true, result: { operation: "tabs", action: "claim" } });
    expect((claimed as { result: { tabs: unknown[] } }).result.tabs).toContainEqual(expect.objectContaining({
      tabId: "tab-1",
      provenance: "agent-created",
      ownership: "owned",
    }));
    const claimObservationRef = (claimed as { result: { observationRef: string } }).result.observationRef;
    liveTargets.set("tab-2", { ...liveTargets.get("tab-2")!, targetGeneration: 2 });
    const stale = await driver.execute({ ...open("tab-1", "stale-finalize"), request: {
      ...open("tab-1", "stale-finalize").request,
      operation: "tabs",
      args: { action: "finalize", idempotencyKey: "stale-finalize-key", observationRef: claimObservationRef, dispositions: [] },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(stale).toMatchObject({ ok: false, error: { code: "STALE_TARGET_GENERATION", effect: "none" } });
    expect(close).not.toHaveBeenCalled();
    const refreshed = await driver.execute({ ...open("tab-1", "refresh"), request: {
      ...open("tab-1", "refresh").request,
      operation: "inspect",
      args: { includeScreenshot: false, includeDiagnostics: false },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    const refreshedObservationRef = (refreshed as { result: { observationRef: string } }).result.observationRef;
    const finalized = await driver.execute({ ...open("tab-1", "finalize"), request: {
      ...open("tab-1", "finalize").request,
      operation: "tabs",
      args: {
        action: "finalize",
        idempotencyKey: "finalize-key",
        observationRef: refreshedObservationRef,
        dispositions: [
          { tabId: "tab-1", disposition: "handoff" },
          { tabId: "tab-2", disposition: "deliverable" },
        ],
      },
    } } as BrowserAutomationHostDispatch, new AbortController().signal);
    expect(finalized).toMatchObject({
      ok: true,
      result: {
        tabs: [
          { tabId: "tab-1", disposition: "handoff", ownership: "released" },
          { tabId: "tab-2", disposition: "deliverable", ownership: "released" },
        ],
      },
    });
    expect(close.mock.calls.map(([target]) => target.tabId)).toEqual(["tab-3"]);
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab-1" }), "workspace");
    await driver.releaseProviderSession("session");
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports a preserved failure when a handed-off tab cannot be activated", async () => {
    const target = browserTarget("tab-handoff");
    const liveTargets = new Map([[target.tabId, target]]);
    const execute = vi.fn(async (dispatch: BrowserAutomationHostDispatch) => ({
      contractVersion: 1,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: true,
      result: dispatch.request.operation === "inspect"
        ? { operation: "inspect", tabs: [target] }
        : { operation: "open", url: "https://example.test", title: "Example", controlEpoch: 0 },
    }) as BrowserAutomationResponse);
    const close = vi.fn(async () => undefined);
    const driver = new BrowserSessionDriver({
      web: { execute },
      electron: { execute },
      isElectron: () => false,
      webTabs: {
        list: async () => [...liveTargets.values()],
        close,
        activate: vi.fn(async () => {
          throw new Error("activation failed");
        }),
      },
    });

    await driver.execute(openTabDispatch(target, "open", 1), new AbortController().signal);
    const inspected = await driver.execute(
      inspectTabDispatch(target, "inspect", 2),
      new AbortController().signal,
    );
    const observationRef = (inspected as { result: { observationRef: string } }).result.observationRef;
    const finalized = await driver.execute(
      tabsDispatch(target, "finalize", 3, observationRef, {
        action: "finalize",
        dispositions: [{ tabId: target.tabId, disposition: "handoff" }],
      }),
      new AbortController().signal,
    );

    expect(finalized).toMatchObject({
      ok: false,
      error: {
        code: "TAB_UNAVAILABLE",
        retryable: true,
        stage: "effect",
        effect: "preserved",
        recovery: "inspect",
      },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("normalizes web and Electron ownership outcomes while using runtime-specific cleanup", async () => {
    const run = async (electronRuntime: boolean) => {
      const webClose = vi.fn();
      const electronClose = vi.fn();
      let closed = false;
      const execute = vi.fn(async (value: BrowserAutomationHostDispatch) => ({
        contractVersion: 1,
        requestId: value.request.requestId,
        sequence: value.request.sequence,
        ok: true,
        result: { operation: "open", url: "about:blank", title: "", controlEpoch: 0 },
      }) as BrowserAutomationResponse);
      const driver = new BrowserSessionDriver({
        web: { execute }, electron: { execute }, isElectron: () => electronRuntime,
        webTabs: { list: async (value) => closed ? [] : [value.target], close: async (target) => { closed = true; webClose(target); } },
        electronTabs: { list: async (value) => closed ? [] : [value.target], close: async (target) => { closed = true; electronClose(target); } },
      });
      const opened = {
        connection: { connectionGeneration: 1, capabilityRevision: 1 },
        target: { threadId: "thread", tabId: "agent-tab", windowId: 1, connectionGeneration: 1, targetGeneration: 1 },
        request: {
          contractVersion: 1, workspaceId: "workspace", threadId: "thread", providerSessionId: "session", providerInstanceId: "instance",
          requestId: "open", sequence: 1, deadline: Date.now() + 10_000, expectedControlEpoch: 0, operation: "open", args: { idempotencyKey: "open-key" },
        },
      } as BrowserAutomationHostDispatch;
      const openResponse = await driver.execute(opened, new AbortController().signal);
      const observationRef = (openResponse as { result: { observationRef: string } }).result.observationRef;
      const result = await driver.execute({ ...opened, request: {
        ...opened.request,
        requestId: "finalize",
        operation: "tabs",
        args: { action: "finalize", idempotencyKey: "finalize-key", observationRef, dispositions: [] },
      } } as BrowserAutomationHostDispatch, new AbortController().signal);
      return { result, webClose, electronClose };
    };

    const web = await run(false);
    const electron = await run(true);
    expect(web.result).toEqual(electron.result);
    expect(web.result).toMatchObject({ ok: true, result: { operation: "tabs", action: "finalize", tabs: [] } });
    expect(web.webClose).toHaveBeenCalledOnce();
    expect(web.electronClose).not.toHaveBeenCalled();
    expect(electron.electronClose).toHaveBeenCalledOnce();
    expect(electron.webClose).not.toHaveBeenCalled();
  });
});
