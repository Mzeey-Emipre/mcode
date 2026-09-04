import type { ProviderModelInfo } from "@mcode/contracts";

/** Upstream API generation that owns an ask and its reply endpoint. */
export type OpenCodeRequestVersion = "legacy" | "v2";

/** Cancellation options for one OpenCode request owned by a running turn. */
export interface OpenCodeRequestOptions {
  signal?: AbortSignal;
}

/** Cancellation and timeout options for one OpenCode status read. */
export interface OpenCodeStatusRequestOptions extends OpenCodeRequestOptions {
  timeoutMs?: number;
}

/** Upstream reported that the session owning a reply no longer exists. */
export class OpenCodeReplySessionNotFoundError extends Error {
  constructor() {
    super("OpenCode reply failed because its session no longer exists");
    this.name = "OpenCodeReplySessionNotFoundError";
  }
}

/** Narrow HTTP surface the OpenCode provider needs from one `serve` instance. */
export interface OpenCodeHttpClient {
  createSession(baseUrl: string, title?: string): Promise<{ id: string }>;
  promptAsync(baseUrl: string, sessionId: string, body: Record<string, unknown>): Promise<void>;
  abortSession(baseUrl: string, sessionId: string): Promise<void>;
  /**
   * Relay one user decision to a pending permission request.
   * `once` approves a single run, `always` approves for the session,
   * `reject` denies it. Only a typed PermissionNotFound 404 means upstream
   * already consumed the request; a missing session remains visible.
   */
  replyPermission(
    baseUrl: string,
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
    version: OpenCodeRequestVersion,
    options?: OpenCodeRequestOptions,
  ): Promise<void>;
  /**
   * Answer a pending question request with one label selection per question.
   * Only a typed QuestionNotFound 404 means upstream already consumed it.
   */
  replyQuestion(
    baseUrl: string,
    sessionId: string,
    requestId: string,
    answers: string[][],
    version: OpenCodeRequestVersion,
    options?: OpenCodeRequestOptions,
  ): Promise<void>;
  /** Dismiss a pending question request. Only QuestionNotFound is idempotent. */
  rejectQuestion(
    baseUrl: string,
    sessionId: string,
    requestId: string,
    version: OpenCodeRequestVersion,
    options?: OpenCodeRequestOptions,
  ): Promise<void>;
  /**
   * Read live session status for every session on one `serve` instance.
   * Used to confirm an idle event before settling the turn: upstream emits
   * `session.idle` between steps of a multi-step turn, so the first idle is
   * never terminal proof on its own.
   */
  getSessionStatus(baseUrl: string, options?: OpenCodeStatusRequestOptions): Promise<Record<string, { type: string }>>;
  listModels(baseUrl: string): Promise<ProviderModelInfo[]>;
  subscribeEvents(baseUrl: string, signal: AbortSignal, onEnvelope: (envelope: unknown) => void): Promise<void>;
  /**
   * Read one bounded page of upstream session history. The limit is always
   * sent and clamped; there is no unbounded full-history fetch.
   */
  listSessionMessages(
    baseUrl: string,
    sessionId: string,
    options?: { limit?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown[]>;
}

/** Default page size for upstream history reads. */
export const OPENCODE_HISTORY_DEFAULT_LIMIT = 50;
/** Largest single upstream history page; keeps heavy sessions fast. */
export const OPENCODE_HISTORY_MAX_LIMIT = 200;
/** Longest wait for one upstream history page before the turn errors visibly. */
export const OPENCODE_HISTORY_TIMEOUT_MS = 10_000;
/** Longest one OpenCode status request can hold idle confirmation. */
export const OPENCODE_STATUS_TIMEOUT_MS = 10_000;

const MAX_SSE_BUFFER_BYTES = 262_144;
const MAX_STATUS_SESSIONS = 256;
const MAX_STATUS_SESSION_ID_CHARS = 512;
const MAX_STATUS_TYPE_CHARS = 64;
const OVERSIZED_SSE_ENVELOPE = { type: "mcode.adapter.oversized-sse-frame", properties: {} };
const MALFORMED_SSE_ENVELOPE = { type: "mcode.adapter.malformed-sse-frame", properties: {} };

function checkStatus(res: Response, what: string): void {
  if (res.ok) return;
  throw new Error(`OpenCode ${what} failed with HTTP ${res.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Clamp a requested history page to one bounded page; never unbounded. */
function clampHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return OPENCODE_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(OPENCODE_HISTORY_MAX_LIMIT, Math.floor(limit as number)));
}

function fetchSessionHistory(url: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  return new Promise<Response>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("OpenCode session history timed out")), timeoutMs);
    timer.unref?.();
    abortListener = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) {
      abortListener();
      return;
    }
    signal?.addEventListener("abort", abortListener, { once: true });
    fetch(url, { signal }).then(resolve, reject);
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  });
}

function fetchSessionStatus(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  return new Promise<unknown>((resolve, reject) => {
    const rejectWith = (error: Error | DOMException): void => {
      controller.abort(error);
      reject(error);
    };
    timer = setTimeout(() => rejectWith(new Error("OpenCode session status timed out")), timeoutMs);
    timer.unref?.();
    abortListener = () => rejectWith(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) {
      abortListener();
      return;
    }
    signal?.addEventListener("abort", abortListener, { once: true });
    void fetch(url, { signal: controller.signal })
      .then((res) => {
        checkStatus(res, "read session status");
        return res.json();
      })
      .then(resolve, reject);
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  });
}

function boundedStatusTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return OPENCODE_STATUS_TIMEOUT_MS;
  return Math.max(1, Math.min(OPENCODE_STATUS_TIMEOUT_MS, Math.floor(timeoutMs as number)));
}

async function consumeReplyNotFound(res: Response, expectedTag: string, what: string): Promise<void> {
  if (res.status !== 404) {
    checkStatus(res, what);
    return;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    checkStatus(res, what);
    return;
  }
  if (isRecord(body) && body._tag === expectedTag) return;
  if (isRecord(body) && body._tag === "SessionNotFoundError") {
    throw new OpenCodeReplySessionNotFoundError();
  }
  checkStatus(res, what);
}

function boundedStatusType(sessionId: string, status: unknown): { type: string } | undefined {
  if (sessionId.length === 0 || sessionId.length > MAX_STATUS_SESSION_ID_CHARS || !isRecord(status)) return undefined;
  const type = status.type;
  if (typeof type !== "string" || type.length === 0 || type.length > MAX_STATUS_TYPE_CHARS) return undefined;
  return { type };
}

function boundedSessionStatuses(data: unknown): Record<string, { type: string }> {
  if (!isRecord(data)) throw new Error("OpenCode session status returned a malformed payload");
  const out: Record<string, { type: string }> = Object.create(null);
  let examined = 0;
  for (const sessionId in data) {
    if (!Object.prototype.hasOwnProperty.call(data, sessionId)) continue;
    if (examined >= MAX_STATUS_SESSIONS) break;
    examined += 1;
    const status = boundedStatusType(sessionId, data[sessionId]);
    if (status) out[sessionId] = status;
  }
  return out;
}

function emitSseBlock(block: string, onEnvelope: (envelope: unknown) => void): void {
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    emitSseDataLine(trimmed, onEnvelope);
  }
}

function emitSseDataLine(trimmed: string, onEnvelope: (envelope: unknown) => void): void {
  const payload = trimmed.slice(5).trim();
  if (!payload) return;
  try {
    onEnvelope(JSON.parse(payload));
  } catch {
    onEnvelope(MALFORMED_SSE_ENVELOPE);
  }
}

function sseFrameBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const frame = new Uint8Array(left.byteLength + right.byteLength);
  frame.set(left);
  frame.set(right, left.byteLength);
  return frame;
}

function nextSseDelimiter(bytes: Uint8Array, offset: number): number {
  for (let index = offset; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) return index;
  }
  return -1;
}

function hasSseDelimiterAcrossBoundary(incomplete: Uint8Array, value: Uint8Array): boolean {
  return incomplete.byteLength > 0 && incomplete[incomplete.byteLength - 1] === 10 && value[0] === 10;
}

function emitSseFrame(
  bytes: Uint8Array,
  decoder: TextDecoder,
  onEnvelope: (envelope: unknown) => void,
): boolean {
  if (bytes.byteLength > MAX_SSE_BUFFER_BYTES) {
    onEnvelope(OVERSIZED_SSE_ENVELOPE);
    return false;
  }
  emitSseBlock(decoder.decode(bytes), onEnvelope);
  return true;
}

async function drainSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEnvelope: (envelope: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let incomplete: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    let offset = 0;
    if (hasSseDelimiterAcrossBoundary(incomplete, value)) {
      if (!emitSseFrame(incomplete.subarray(0, incomplete.byteLength - 1), decoder, onEnvelope)) {
        await reader.cancel();
        return;
      }
      incomplete = new Uint8Array();
      offset = 1;
    }
    for (;;) {
      const delimiter = nextSseDelimiter(value, offset);
      if (delimiter === -1) break;
      if (incomplete.byteLength + delimiter - offset > MAX_SSE_BUFFER_BYTES) {
        onEnvelope(OVERSIZED_SSE_ENVELOPE);
        await reader.cancel();
        return;
      }
      const frame = sseFrameBytes(incomplete, value.subarray(offset, delimiter));
      incomplete = new Uint8Array();
      if (!emitSseFrame(frame, decoder, onEnvelope)) {
        await reader.cancel();
        return;
      }
      offset = delimiter + 2;
    }
    const remainder = value.subarray(offset);
    if (incomplete.byteLength + remainder.byteLength > MAX_SSE_BUFFER_BYTES) {
      onEnvelope(OVERSIZED_SSE_ENVELOPE);
      await reader.cancel();
      return;
    }
    incomplete = sseFrameBytes(incomplete, remainder);
  }
}

/** Default fetch-based client over the `opencode serve` REST + SSE surface. */
export const defaultOpenCodeHttpClient: OpenCodeHttpClient = {
  async createSession(baseUrl, title) {
    const res = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    });
    checkStatus(res, "create session");
    const data = (await res.json()) as { id: string };
    if (!data || typeof data.id !== "string") throw new Error("OpenCode create session returned no id");
    return { id: data.id };
  },

  async promptAsync(baseUrl, sessionId, body) {
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 204 && !res.ok) throw new Error(`OpenCode prompt_async failed with HTTP ${res.status}`);
  },

  async abortSession(baseUrl, sessionId) {
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    if (!res.ok && res.status !== 404) throw new Error(`OpenCode abort failed with HTTP ${res.status}`);
  },

  async replyPermission(baseUrl, sessionId, permissionId, response, version, options) {
    const path = version === "v2"
      ? `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionId)}/reply`
      : `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`;
    const res = await fetch(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(version === "v2" ? { reply: response } : { response }),
        signal: options?.signal,
      },
    );
    await consumeReplyNotFound(res, "PermissionNotFoundError", "reply permission");
  },

  async replyQuestion(baseUrl, sessionId, requestId, answers, version, options) {
    const path = version === "v2"
      ? `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply`
      : `/question/${encodeURIComponent(requestId)}/reply`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
      signal: options?.signal,
    });
    await consumeReplyNotFound(res, "QuestionNotFoundError", "reply question");
  },

  async rejectQuestion(baseUrl, sessionId, requestId, version, options) {
    const path = version === "v2"
      ? `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`
      : `/question/${encodeURIComponent(requestId)}/reject`;
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", signal: options?.signal });
    await consumeReplyNotFound(res, "QuestionNotFoundError", "reject question");
  },

  async getSessionStatus(baseUrl, options) {
    const data = await fetchSessionStatus(
      `${baseUrl}/session/status`,
      boundedStatusTimeout(options?.timeoutMs),
      options?.signal,
    );
    return boundedSessionStatuses(data);
  },

  async listModels(baseUrl) {
    const res = await fetch(`${baseUrl}/config/providers`);
    checkStatus(res, "list providers");
    const data = (await res.json()) as {
      providers?: Array<{ id: string; name: string; models?: Record<string, { id?: string; name?: string; limit?: { context?: number } }> }>;
    };
    const out: ProviderModelInfo[] = [];
    for (const provider of data.providers ?? []) {
      for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
        const id = `${provider.id}/${model.id ?? modelKey}`;
        out.push({
          id,
          name: model.name ?? modelKey,
          group: provider.name,
          contextWindow: model.limit?.context,
        });
      }
    }
    return out;
  },

  async subscribeEvents(baseUrl, signal, onEnvelope) {
    const res = await fetch(`${baseUrl}/event`, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    checkStatus(res, "subscribe events");
    const reader = res.body?.getReader();
    if (!reader) return;
    await drainSseStream(reader, onEnvelope);
  },

  async listSessionMessages(baseUrl, sessionId, options) {
    const limit = clampHistoryLimit(options?.limit);
    const timeoutMs = options?.timeoutMs ?? OPENCODE_HISTORY_TIMEOUT_MS;
    // Race the fetch against the timeout so a stalled upstream fails visibly
    // instead of hanging the turn behind an endless spinner. Listeners come
    // off in the finally so repeated resumes never accumulate them.
    const url = `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?limit=${limit}`;
    const res = await fetchSessionHistory(url, timeoutMs, options?.signal);
    if (res.status === 404) throw new Error(`OpenCode session history failed with HTTP 404 for ${sessionId}`);
    if (!res.ok) throw new Error(`OpenCode session history failed with HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) throw new Error("OpenCode session history returned a malformed payload");
    return data;
  },
};
