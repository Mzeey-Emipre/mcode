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

interface RecordingSessionWithResolver extends RecordingSession {
  readonly resolveStopped: () => void;
}

interface PendingRecordingAcquisition {
  readonly requestKey: string;
  readonly workspaceId: string;
  readonly threadId: string;
  cancelled: boolean;
}

type RecordingStartResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: BrowserAutomationResponse };

type RecordingMediaSource = Extract<
  Awaited<ReturnType<PreviewAutomationBridge["getMediaSourceId"]>>,
  { readonly ok: true }
>;

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
  private readonly pendingAcquisitions = new Map<string, PendingRecordingAcquisition>();
  private disposed = false;

  private clearPendingAcquisition(key: string, acquisition: PendingRecordingAcquisition): void {
    if (this.pendingAcquisitions.get(key) === acquisition) this.pendingAcquisitions.delete(key);
  }

  private acquisitionWasCancelled(acquisition: PendingRecordingAcquisition): boolean {
    return this.disposed || acquisition.cancelled;
  }

  private stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop();
  }

  private async acquireMediaSource(
    dispatch: BrowserAutomationHostDispatch,
    bridge: PreviewAutomationBridge,
    key: string,
    acquisition: PendingRecordingAcquisition,
  ): Promise<RecordingStartResult<RecordingMediaSource>> {
    try {
      const source = await acquireBeforeDeadline(bridge.getMediaSourceId({
        windowId: dispatch.target.windowId,
        threadId: dispatch.target.threadId,
        tabId: dispatch.target.tabId,
        targetGeneration: dispatch.target.targetGeneration,
      }), dispatch.request.deadline);
      if (!source.ok) {
        acquisition.cancelled = true;
        this.clearPendingAcquisition(key, acquisition);
        return { ok: false, response: failure(dispatch, "Browser capture source acquisition exceeded the request deadline") };
      }
      if (!source.value.ok || source.value.expiresAt <= Date.now()) {
        this.clearPendingAcquisition(key, acquisition);
        return { ok: false, response: failure(dispatch, "The browser tab capture source is unavailable or expired") };
      }
      if (this.acquisitionWasCancelled(acquisition)) {
        this.clearPendingAcquisition(key, acquisition);
        return { ok: false, response: failure(dispatch, "Browser recording was cancelled") };
      }
      return { ok: true, value: source.value };
    } catch {
      this.clearPendingAcquisition(key, acquisition);
      return { ok: false, response: failure(dispatch, "The browser tab capture source is unavailable") };
    }
  }

  private async acquireCaptureStream(
    dispatch: BrowserAutomationHostDispatch,
    source: RecordingMediaSource,
    key: string,
    acquisition: PendingRecordingAcquisition,
  ): Promise<RecordingStartResult<MediaStream>> {
    let streamPromise: Promise<MediaStream>;
    try {
      streamPromise = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: source.mediaSourceId,
          },
        } as MediaTrackConstraints,
      });
    } catch {
      this.clearPendingAcquisition(key, acquisition);
      return { ok: false, response: failure(dispatch, "The browser tab could not be captured") };
    }
    void streamPromise.then((lateStream) => {
      if (!this.acquisitionWasCancelled(acquisition)) return;
      this.stopStream(lateStream);
    }).catch(() => undefined);
    try {
      const stream = await acquireBeforeDeadline(
        streamPromise,
        Math.min(dispatch.request.deadline, source.expiresAt),
      );
      if (!stream.ok) {
        acquisition.cancelled = true;
        this.clearPendingAcquisition(key, acquisition);
        return { ok: false, response: failure(dispatch, "Browser tab capture exceeded the request deadline") };
      }
      return { ok: true, value: stream.value };
    } catch {
      this.clearPendingAcquisition(key, acquisition);
      return { ok: false, response: failure(dispatch, "The browser tab could not be captured") };
    }
  }

  private createRecorder(
    dispatch: BrowserAutomationHostDispatch,
    stream: MediaStream,
    key: string,
    acquisition: PendingRecordingAcquisition,
  ): RecordingStartResult<MediaRecorder> {
    if (typeof MediaRecorder.isTypeSupported === "function" && !MediaRecorder.isTypeSupported("video/webm")) {
      this.stopStream(stream);
      this.clearPendingAcquisition(key, acquisition);
      return { ok: false, response: failure(dispatch, "The browser recording encoder does not support WebM") };
    }
    try {
      return { ok: true, value: new MediaRecorder(stream, { mimeType: "video/webm" }) };
    } catch {
      this.stopStream(stream);
      this.clearPendingAcquisition(key, acquisition);
      return { ok: false, response: failure(dispatch, "The browser recording encoder is unavailable") };
    }
  }

  private createSession(
    dispatch: BrowserAutomationHostDispatch,
    key: string,
    recorder: MediaRecorder,
    stream: MediaStream,
  ): RecordingSessionWithResolver {
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    return {
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
      resolveStopped,
    };
  }

  private configureRecorder(
    session: RecordingSessionWithResolver,
    key: string,
    acquisition: PendingRecordingAcquisition,
  ): RecordingSession {
    const { recorder, stream } = session;
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
      this.stopStream(stream);
      this.clearPendingAcquisition(key, acquisition);
      session.resolveStopped();
    };
    recorder.onerror = () => {
      session.error = "The browser recording encoder failed";
      window.clearTimeout(session.stopTimer);
      if (recorder.state !== "inactive") recorder.stop();
      this.stopStream(stream);
      session.resolveStopped();
    };
    return session;
  }

  private startRecorder(
    dispatch: BrowserAutomationHostDispatch,
    session: RecordingSession,
    key: string,
    acquisition: PendingRecordingAcquisition,
  ): BrowserAutomationResponse | null {
    try {
      session.recorder.start(RECORDING_TIMESLICE_MS);
      return null;
    } catch {
      this.stopStream(session.stream);
      this.clearPendingAcquisition(key, acquisition);
      return failure(dispatch, "The browser recording encoder could not start");
    }
  }

  private recordingStartedResponse(
    dispatch: BrowserAutomationHostDispatch,
    session: RecordingSession,
  ): BrowserAutomationResponse {
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
    const acquisition: PendingRecordingAcquisition = {
      requestKey,
      workspaceId: dispatch.scope.workspaceId,
      threadId: dispatch.target.threadId,
      cancelled: false,
    };
    this.pendingAcquisitions.set(key, acquisition);
    const source = await this.acquireMediaSource(dispatch, bridge, key, acquisition);
    if (!source.ok) return source.response;
    const stream = await this.acquireCaptureStream(dispatch, source.value, key, acquisition);
    if (!stream.ok) return stream.response;
    if (this.acquisitionWasCancelled(acquisition)) {
      this.stopStream(stream.value);
      this.clearPendingAcquisition(key, acquisition);
      return failure(dispatch, "Browser recording was cancelled");
    }
    const recorder = this.createRecorder(dispatch, stream.value, key, acquisition);
    if (!recorder.ok) return recorder.response;
    const session = this.configureRecorder(this.createSession(dispatch, key, recorder.value, stream.value), key, acquisition);
    const startFailure = this.startRecorder(dispatch, session, key, acquisition);
    if (startFailure) return startFailure;
    const requestedDuration = dispatch.request.operation === "recordingStart"
      ? dispatch.request.args.maxDurationMs
      : MAX_RECORDING_DURATION_MS;
    session.stopTimer = window.setTimeout(() => {
      if (session.recorder.state !== "inactive") session.recorder.stop();
    }, Math.min(requestedDuration, MAX_RECORDING_DURATION_MS));
    this.sessions.set(key, session);
    this.clearPendingAcquisition(key, acquisition);
    return this.recordingStartedResponse(dispatch, session);
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
    for (const session of this.sessions.values()) {
      this.disposeTarget(...(JSON.parse(session.targetKey) as [string, string, string]));
    }
    for (const acquisition of this.pendingAcquisitions.values()) acquisition.cancelled = true;
  }
}
