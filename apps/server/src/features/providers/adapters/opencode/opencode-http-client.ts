import type { ProviderModelInfo } from "@mcode/contracts";

/** Narrow HTTP surface the OpenCode provider needs from one `serve` instance. */
export interface OpenCodeHttpClient {
  createSession(baseUrl: string, title?: string): Promise<{ id: string }>;
  promptAsync(baseUrl: string, sessionId: string, body: Record<string, unknown>): Promise<void>;
  abortSession(baseUrl: string, sessionId: string): Promise<void>;
  listModels(baseUrl: string): Promise<ProviderModelInfo[]>;
  subscribeEvents(baseUrl: string, signal: AbortSignal, onEnvelope: (envelope: unknown) => void): Promise<void>;
}

function checkStatus(res: Response, what: string): void {
  if (res.ok) return;
  throw new Error(`OpenCode ${what} failed with HTTP ${res.status}`);
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
};
