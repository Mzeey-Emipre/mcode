import type { ProviderModelInfo } from "@mcode/contracts";

/** Narrow HTTP surface the OpenCode provider needs from one `serve` instance. */
export interface OpenCodeHttpClient {
  createSession(baseUrl: string, title?: string): Promise<{ id: string }>;
  promptAsync(baseUrl: string, sessionId: string, body: Record<string, unknown>): Promise<void>;
  abortSession(baseUrl: string, sessionId: string): Promise<void>;
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

function checkStatus(res: Response, what: string): void {
  if (res.ok) return;
  throw new Error(`OpenCode ${what} failed with HTTP ${res.status}`);
}

/** Clamp a requested history page to one bounded page; never unbounded. */
function clampHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return OPENCODE_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(OPENCODE_HISTORY_MAX_LIMIT, Math.floor(limit as number)));
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
    // A single malformed SSE frame must not kill the stream.
  }
}

async function drainSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEnvelope: (envelope: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) emitSseBlock(block, onEnvelope);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (reject: (reason?: unknown) => void): void => {
      reject(options?.signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    let abortListener: (() => void) | undefined;
    try {
      const res = await new Promise<Response>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("OpenCode session history timed out")), timeoutMs);
        timer.unref?.();
        abortListener = () => onAbort(reject);
        if (options?.signal?.aborted) {
          abortListener();
          return;
        }
        options?.signal?.addEventListener("abort", abortListener, { once: true });
        fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message?limit=${limit}`, {
          signal: options?.signal,
        }).then(resolve, reject);
      });
      if (res.status === 404) throw new Error(`OpenCode session history failed with HTTP 404 for ${sessionId}`);
      if (!res.ok) throw new Error(`OpenCode session history failed with HTTP ${res.status}`);
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) throw new Error("OpenCode session history returned a malformed payload");
      return data;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener) options?.signal?.removeEventListener("abort", abortListener);
    }
  },
};
