import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_RECORDING_BYTES,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import type { PreviewAutomationBridge } from "@/transport/desktop-bridge";
import { browserAutomationRequestKey, browserAutomationTargetKey } from "./browserAutomationStore";

const MAX_RECORDING_DURATION_MS = 10 * 60_000;
const RECORDING_TIMESLICE_MS = 250;
const SAFE_RECORDING_BYTES = Math.min(BROWSER_AUTOMATION_MAX_RECORDING_BYTES, 360 * 1_024);

async function acquireBeforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer = 0;
  try {
    return await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false }>((resolve) => {
        timer = window.setTimeout(() => resolve({ ok: false }), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

interface RecordingSession {
  readonly id: string;
  readonly targetKey: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly startedAt: number;
  readonly chunks: Blob[];
  retainedBytes: number;
  totalBytes: number;
  stopped: Promise<void>;
  stopTimer: number;
  error: string | null;
}

function failure(dispatch: BrowserAutomationHostDispatch, message: string): BrowserAutomationResponse {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: dispatch.request.requestId,
    sequence: dispatch.request.sequence,
    ok: false,
    error: { code: "RECORDING_NOT_ACTIVE", message, retryable: false },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Owns bounded MediaRecorder sessions for exact visible Browser targets. */
export class BrowserAutomationRecorder {
  private readonly sessions = new Map<string, RecordingSession>();
  private readonly pendingAcquisitions = new Map<string, {
    requestKey: string;
    workspaceId: string;
    threadId: string;
    cancelled: boolean;
  }>();
  private disposed = false;

  /** Start one target-scoped WebM recording from the desktop-issued media source. */
  async start(
    dispatch: BrowserAutomationHostDispatch,
    bridge: PreviewAutomationBridge,
  ): Promise<BrowserAutomationResponse> {
    const key = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
    const requestKey = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
    if (this.sessions.has(key) || this.pendingAcquisitions.has(key)) {
      return failure(dispatch, "A recording is already active for this browser tab");
    }
    const acquisition = { requestKey, workspaceId: dispatch.scope.workspaceId, threadId: dispatch.target.threadId, cancelled: false };
    this.pendingAcquisitions.set(key, acquisition);
    let source: Awaited<ReturnType<PreviewAutomationBridge["getMediaSourceId"]>>;
    try {
      const acquiredSource = await acquireBeforeDeadline(bridge.getMediaSourceId({
        windowId: dispatch.target.windowId,
        threadId: dispatch.target.threadId,
        tabId: dispatch.target.tabId,
        targetGeneration: dispatch.target.targetGeneration,
      }), dispatch.request.deadline);
      if (!acquiredSource.ok) {
        acquisition.cancelled = true;
        if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
        return failure(dispatch, "Browser capture source acquisition exceeded the request deadline");
      }
      source = acquiredSource.value;
    } catch {
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "The browser tab capture source is unavailable");
    }
    if (!source.ok || source.expiresAt <= Date.now()) {
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "The browser tab capture source is unavailable or expired");
    }
    if (this.disposed || acquisition.cancelled) {
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "Browser recording was cancelled");
    }
    let stream: MediaStream;
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: source.mediaSourceId,
          },
        } as MediaTrackConstraints,
      });
      void streamPromise.then((lateStream) => {
        if (!acquisition.cancelled && !this.disposed) return;
        for (const track of lateStream.getTracks()) track.stop();
      }).catch(() => undefined);
      const acquiredStream = await acquireBeforeDeadline(
        streamPromise,
        Math.min(dispatch.request.deadline, source.expiresAt),
      );
      if (!acquiredStream.ok) {
        acquisition.cancelled = true;
        if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
        return failure(dispatch, "Browser tab capture exceeded the request deadline");
      }
      stream = acquiredStream.value;
    } catch {
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "The browser tab could not be captured");
    }
    if (this.disposed || acquisition.cancelled) {
      for (const track of stream.getTracks()) track.stop();
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "Browser recording was cancelled");
    }
    let recorder: MediaRecorder;
    if (typeof MediaRecorder.isTypeSupported === "function" && !MediaRecorder.isTypeSupported("video/webm")) {
      for (const track of stream.getTracks()) track.stop();
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "The browser recording encoder does not support WebM");
    }
    try {
      recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    } catch {
      for (const track of stream.getTracks()) track.stop();
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "The browser recording encoder is unavailable");
    }
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const session: RecordingSession = {
      id: crypto.randomUUID(),
      targetKey: key,
      workspaceId: dispatch.scope.workspaceId,
      threadId: dispatch.target.threadId,
      recorder,
      stream,
      startedAt: Date.now(),
      chunks: [],
      retainedBytes: 0,
      totalBytes: 0,
      stopped,
      stopTimer: 0,
      error: null,
    };
    recorder.ondataavailable = (event) => {
      session.totalBytes += event.data.size;
      if (session.retainedBytes + event.data.size > SAFE_RECORDING_BYTES) {
        if (recorder.state !== "inactive") recorder.stop();
        return;
      }
      session.chunks.push(event.data);
      session.retainedBytes += event.data.size;
    };
    recorder.onstop = () => {
      window.clearTimeout(session.stopTimer);
      for (const track of stream.getTracks()) track.stop();
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      resolveStopped();
    };
    recorder.onerror = () => {
      session.error = "The browser recording encoder failed";
      window.clearTimeout(session.stopTimer);
      if (recorder.state !== "inactive") recorder.stop();
      for (const track of stream.getTracks()) track.stop();
      resolveStopped();
    };
    try {
      recorder.start(RECORDING_TIMESLICE_MS);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
      return failure(dispatch, "The browser recording encoder could not start");
    }
    const requestedDuration = dispatch.request.operation === "recordingStart"
      ? dispatch.request.args.maxDurationMs
      : MAX_RECORDING_DURATION_MS;
    session.stopTimer = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, Math.min(requestedDuration, MAX_RECORDING_DURATION_MS));
    this.sessions.set(key, session);
    if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
    return {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: true,
      result: {
        operation: "recordingStart",
        recordingId: session.id,
        startedAt: session.startedAt,
        controlEpoch: dispatch.request.expectedControlEpoch,
      },
    };
  }

  /** Report whether a thread owns an active or pending recording lease. */
  hasActiveThread(workspaceId: string, threadId: string): boolean {
    return [...this.sessions.values()].some((session) => session.workspaceId === workspaceId && session.threadId === threadId) ||
      [...this.pendingAcquisitions.values()].some((acquisition) => acquisition.workspaceId === workspaceId && acquisition.threadId === threadId);
  }

  /** Stop one exact recording and return a bounded base64 WebM result. */
  async stop(dispatch: BrowserAutomationHostDispatch): Promise<BrowserAutomationResponse> {
    const key = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
    const session = this.sessions.get(key);
    if (!session) return failure(dispatch, "No recording is active for this browser tab");
    if (session.recorder.state !== "inactive") session.recorder.stop();
    let stopTimedOut = false;
    let stopTimeout = 0;
    await Promise.race([
      session.stopped,
      new Promise<void>((resolve) => {
        stopTimeout = window.setTimeout(() => {
        stopTimedOut = true;
        for (const track of session.stream.getTracks()) track.stop();
        resolve();
        }, 1_000);
      }),
    ]);
    window.clearTimeout(stopTimeout);
    this.sessions.delete(key);
    if (stopTimedOut) return failure(dispatch, "The browser recording encoder did not stop");
    if (session.error) return failure(dispatch, session.error);
    const retained = new Uint8Array(await new Blob(session.chunks, { type: "video/webm" }).arrayBuffer());
    const truncated = session.totalBytes > retained.byteLength;
    return {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: true,
      result: {
        operation: "recordingStop",
        recordingId: session.id,
        mediaType: "video/webm",
        dataBase64: bytesToBase64(retained),
        durationMs: Math.min(Date.now() - session.startedAt, MAX_RECORDING_DURATION_MS),
        truncation: truncated
          ? { truncated: true, originalCount: session.totalBytes, reason: "byte-limit" }
          : { truncated: false, originalCount: retained.byteLength },
        controlEpoch: dispatch.request.expectedControlEpoch,
      },
    };
  }

  /** Cancel pending acquisition and release any active session for a request target. */
  cancel(dispatch: BrowserAutomationHostDispatch): void {
    const targetKey = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
    const acquisition = this.pendingAcquisitions.get(targetKey);
    if (acquisition?.requestKey === browserAutomationRequestKey(
      dispatch.request.requestId,
      dispatch.request.sequence,
    )) acquisition.cancelled = true;
    this.disposeTarget(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
  }

  /** Release recording resources for one exact Browser target. */
  disposeTarget(workspaceId: string, threadId: string, tabId: string): void {
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    const acquisition = this.pendingAcquisitions.get(key);
    if (acquisition) acquisition.cancelled = true;
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(session.targetKey);
    window.clearTimeout(session.stopTimer);
    if (session.recorder.state !== "inactive") session.recorder.stop();
    for (const track of session.stream.getTracks()) track.stop();
  }

  /** Release every recorder, media track, timer, and pending acquisition. */
  dispose(): void {
    this.disposed = true;
    for (const session of [...this.sessions.values()]) {
      this.disposeTarget(...(JSON.parse(session.targetKey) as [string, string, string]));
    }
    for (const acquisition of this.pendingAcquisitions.values()) acquisition.cancelled = true;
  }
}
