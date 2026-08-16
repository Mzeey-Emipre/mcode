import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, type BrowserAutomationHostDispatch } from "@mcode/contracts";
import type { PreviewAutomationBridge } from "@/transport/desktop-bridge";
import { BrowserAutomationRecorder } from "../browserAutomationRecorder";

class FakeMediaRecorder {
  static supported = true;
  static throwOnConstruct = false;
  static throwOnStart = false;
  static stopEmits = true;
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported() { return FakeMediaRecorder.supported; }
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    if (FakeMediaRecorder.throwOnConstruct) throw new Error("constructor failed");
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    if (FakeMediaRecorder.throwOnStart) throw new Error("start failed");
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (FakeMediaRecorder.stopEmits) queueMicrotask(() => this.onstop?.());
  }
  emit(size: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type: "video/webm" }) } as BlobEvent);
  }
  fail() { this.onerror?.(); }
}

function dispatch(operation: "recordingStart" | "recordingStop", sequence: number): BrowserAutomationHostDispatch {
  return {
    scope: { workspaceId: "ws", threadId: "thread", providerSessionId: "provider", providerInstanceId: "instance" },
    connection: { desktopInstanceId: "desktop", windowId: 1, connectionGeneration: 1, targetGeneration: 1 },
    request: {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      workspaceId: "ws",
      threadId: "thread",
      providerSessionId: "provider",
      providerInstanceId: "instance",
      requestId: `request-${sequence}`,
      sequence,
      deadline: Date.now() + 60_000,
      expectedControlEpoch: 0,
      operation,
      args: operation === "recordingStart" ? { maxDurationMs: 60_000 } : {},
    },
    target: {
      desktopInstanceId: "desktop",
      windowId: 1,
      connectionGeneration: 1,
      threadId: "thread",
      tabId: "tab",
      targetGeneration: 1,
      active: true,
      focused: true,
      lastUsedAt: 10,
    },
  } as BrowserAutomationHostDispatch;
}

describe("BrowserAutomationRecorder", () => {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn();
  const getMediaSourceId = vi.fn();
  const bridge = { getMediaSourceId } as unknown as PreviewAutomationBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.supported = true;
    FakeMediaRecorder.throwOnConstruct = false;
    FakeMediaRecorder.throwOnStart = false;
    FakeMediaRecorder.stopEmits = true;
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    getMediaSourceId.mockResolvedValue({ ok: true, mediaSourceId: "source", expiresAt: Date.now() + 10_000 });
    getUserMedia.mockResolvedValue(stream);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("acquires the exact tab source and starts a bounded timesliced recording", async () => {
    const recorder = new BrowserAutomationRecorder();
    const result = await recorder.start(dispatch("recordingStart", 1), bridge);
    expect(result).toMatchObject({ ok: true, result: { operation: "recordingStart" } });
    expect(getMediaSourceId).toHaveBeenCalledWith({ windowId: 1, threadId: "thread", tabId: "tab", targetGeneration: 1 });
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: expect.any(Object) }));
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
    recorder.dispose();
    expect(stopTrack).toHaveBeenCalled();
  });

  it("rejects a second start while acquisition is pending and cleans cancel-during-acquire", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise<MediaStream>((resolve) => { resolveStream = resolve; }));
    const recorder = new BrowserAutomationRecorder();
    const firstDispatch = dispatch("recordingStart", 1);
    const first = recorder.start(firstDispatch, bridge);
    await Promise.resolve();
    await expect(recorder.start(dispatch("recordingStart", 2), bridge)).resolves.toMatchObject({ ok: false });
    recorder.cancel(firstDispatch);
    resolveStream(stream);
    await expect(first).resolves.toMatchObject({ ok: false });
    expect(stopTrack).toHaveBeenCalled();
  });

  it("keeps repeated cancellation of a never-resolving source bounded by one target lease", async () => {
    getMediaSourceId.mockReturnValue(new Promise(() => undefined));
    const recorder = new BrowserAutomationRecorder();
    const startDispatch = dispatch("recordingStart", 1);
    void recorder.start(startDispatch, bridge);
    await Promise.resolve();
    for (let index = 0; index < 1_000; index += 1) recorder.cancel(startDispatch);
    await expect(recorder.start(dispatch("recordingStart", 2), bridge)).resolves.toMatchObject({ ok: false });
    expect(getMediaSourceId).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    recorder.dispose();
  });

  it("releases never-resolving source acquisition at the request deadline", async () => {
    vi.useFakeTimers();
    getMediaSourceId.mockReturnValueOnce(new Promise(() => undefined));
    const recorder = new BrowserAutomationRecorder();
    const expiring = dispatch("recordingStart", 1);
    const pending = recorder.start({
      ...expiring,
      request: { ...expiring.request, deadline: Date.now() + 50 },
    } as BrowserAutomationHostDispatch, bridge);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ ok: false });

    getMediaSourceId.mockResolvedValueOnce({
      ok: true,
      mediaSourceId: "source",
      expiresAt: Date.now() + 10_000,
    });
    await expect(recorder.start(dispatch("recordingStart", 2), bridge)).resolves.toMatchObject({ ok: true });
    recorder.dispose();
  });

  it("stops a capture stream that resolves after its acquisition deadline", async () => {
    vi.useFakeTimers();
    let resolveStream!: (value: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise<MediaStream>((resolve) => { resolveStream = resolve; }));
    const recorder = new BrowserAutomationRecorder();
    const expiring = dispatch("recordingStart", 1);
    const pending = recorder.start({
      ...expiring,
      request: { ...expiring.request, deadline: Date.now() + 50 },
    } as BrowserAutomationHostDispatch, bridge);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ ok: false });
    resolveStream(stream);
    await Promise.resolve();
    expect(stopTrack).toHaveBeenCalled();
  });

  it("releases the pending target when media-source acquisition rejects", async () => {
    const recorder = new BrowserAutomationRecorder();
    getMediaSourceId.mockRejectedValueOnce(new Error("source failed"));
    await expect(recorder.start(dispatch("recordingStart", 1), bridge)).resolves.toMatchObject({ ok: false });
    getMediaSourceId.mockResolvedValueOnce({
      ok: true,
      mediaSourceId: "source",
      expiresAt: Date.now() + 10_000,
    });
    await expect(recorder.start(dispatch("recordingStart", 2), bridge)).resolves.toMatchObject({ ok: true });
    recorder.dispose();
  });

  it("clears deadline timers across repeated immediate acquisition rejection", async () => {
    vi.useFakeTimers();
    getMediaSourceId.mockRejectedValue(new Error("source failed"));
    const recorder = new BrowserAutomationRecorder();
    for (let index = 0; index < 100; index += 1) {
      await recorder.start(dispatch("recordingStart", index + 1), bridge);
    }
    expect(vi.getTimerCount()).toBe(0);
    recorder.dispose();
  });

  it("retains only complete WebM chunks and stops immediately at the byte bound", async () => {
    const recorder = new BrowserAutomationRecorder();
    await recorder.start(dispatch("recordingStart", 1), bridge);
    const media = FakeMediaRecorder.instances[0]!;
    media.emit(300 * 1_024);
    media.emit(100 * 1_024);
    expect(media.state).toBe("inactive");
    const result = await recorder.stop(dispatch("recordingStop", 2));
    expect(result).toMatchObject({
      ok: true,
      result: { operation: "recordingStop", truncation: { truncated: true, originalCount: 400 * 1_024, reason: "byte-limit" } },
    });
    if (result.ok && result.result.operation === "recordingStop") {
      expect(atob(result.result.dataBase64).length).toBe(300 * 1_024);
    }
  });

  it("fails a never-resolving stop within the cleanup timeout and stops tracks", async () => {
    vi.useFakeTimers();
    FakeMediaRecorder.stopEmits = false;
    const recorder = new BrowserAutomationRecorder();
    await recorder.start(dispatch("recordingStart", 1), bridge);
    const stopping = recorder.stop(dispatch("recordingStop", 2));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stopping).resolves.toMatchObject({ ok: false });
    expect(stopTrack).toHaveBeenCalled();
  });

  it("returns an encoder failure without waiting for the stop timeout", async () => {
    const recorder = new BrowserAutomationRecorder();
    await recorder.start(dispatch("recordingStart", 1), bridge);
    FakeMediaRecorder.instances[0]!.fail();
    await expect(recorder.stop(dispatch("recordingStop", 2))).resolves.toMatchObject({ ok: false });
    expect(stopTrack).toHaveBeenCalled();
  });

  it("stops tracks when WebM is unsupported or construction fails", async () => {
    FakeMediaRecorder.supported = false;
    await expect(new BrowserAutomationRecorder().start(dispatch("recordingStart", 1), bridge)).resolves.toMatchObject({ ok: false });
    FakeMediaRecorder.supported = true;
    FakeMediaRecorder.throwOnConstruct = true;
    await expect(new BrowserAutomationRecorder().start(dispatch("recordingStart", 2), bridge)).resolves.toMatchObject({ ok: false });
    expect(stopTrack).toHaveBeenCalledTimes(2);
  });

  it("stops tracks and releases the target when the encoder cannot start", async () => {
    FakeMediaRecorder.throwOnStart = true;
    const recorder = new BrowserAutomationRecorder();
    await expect(recorder.start(dispatch("recordingStart", 1), bridge)).resolves.toMatchObject({ ok: false });
    FakeMediaRecorder.throwOnStart = false;
    await expect(recorder.start(dispatch("recordingStart", 2), bridge)).resolves.toMatchObject({ ok: true });
    expect(stopTrack).toHaveBeenCalled();
    recorder.dispose();
  });

  it("releases timers, recorder, and tracks on dispose", async () => {
    const recorder = new BrowserAutomationRecorder();
    await recorder.start(dispatch("recordingStart", 1), bridge);
    recorder.dispose();
    expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
    expect(stopTrack).toHaveBeenCalled();
  });
});
