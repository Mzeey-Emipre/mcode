import { describe, expect, it, vi } from "vitest";
import type { BrowserAutomationHostDispatch, BrowserAutomationResponse } from "@mcode/contracts";
import { BrowserSessionDriver, ElectronBrowserSessionAdapter } from "./browserSessionDriver";
import { WebBrowserSessionAdapter } from "./webBrowserSessionAdapter";

const response = {} as BrowserAutomationResponse;
const dispatch = {} as BrowserAutomationHostDispatch;

describe("BrowserSessionDriver", () => {
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
