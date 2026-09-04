import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultOpenCodeHttpClient, OpenCodeReplySessionNotFoundError } from "../opencode-http-client.js";

const BASE = "http://127.0.0.1:4096";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    return handler(url, init);
  }));
  return { urls };
}

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}

describe("listSessionMessages paged history", () => {
  it("always sends a bounded limit (never an unbounded fetch)", async () => {
    const { urls } = stubFetch(() => okJson([]));
    await defaultOpenCodeHttpClient.listSessionMessages(BASE, "ses_1", {});
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/session/ses_1/message");
    expect(urls[0]).toMatch(/limit=\d+/);
    await defaultOpenCodeHttpClient.listSessionMessages(BASE, "ses_1", { limit: 100_000 });
    const clamped = Number(new URL(urls[1]).searchParams.get("limit"));
    expect(clamped).toBeLessThanOrEqual(200);
  });

  it("surfaces a missing session as a 404 so resume can start fresh", async () => {
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }) as Response);
    await expect(defaultOpenCodeHttpClient.listSessionMessages(BASE, "ses_gone", { limit: 1 }))
      .rejects.toThrow(/404/);
  });

  it("surfaces broken history as an error, never a hang", async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    await expect(defaultOpenCodeHttpClient.listSessionMessages(BASE, "ses_1", { limit: 1 }))
      .rejects.toThrow(/history/i);
  });

  it("rejects malformed payloads instead of hanging", async () => {
    stubFetch(() => okJson({ not: "a list" }));
    await expect(defaultOpenCodeHttpClient.listSessionMessages(BASE, "ses_1", { limit: 1 }))
      .rejects.toThrow();
  });

  it("times out a stalled history fetch", async () => {
    stubFetch(() => new Promise(() => {}));
    await expect(
      defaultOpenCodeHttpClient.listSessionMessages(BASE, "ses_1", { limit: 1, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("aborts on the caller signal", async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const pending = defaultOpenCodeHttpClient.listSessionMessages(BASE, "ses_1", {
      limit: 1,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("permission and question replies", () => {
  it("posts each permission generation to its matching endpoint and body", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch((url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => true } as Response;
    });
    await defaultOpenCodeHttpClient.replyPermission(BASE, "ses_1", "per_1", "once", "legacy");
    await defaultOpenCodeHttpClient.replyPermission(BASE, "ses_1", "per_2", "always", "v2");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe(`${BASE}/session/ses_1/permissions/per_1`);
    expect(seen[0]!.init?.method).toBe("POST");
    expect(seen[0]!.init?.body).toBe(JSON.stringify({ response: "once" }));
    expect(seen[1]!.url).toBe(`${BASE}/api/session/ses_1/permission/per_2/reply`);
    expect(seen[1]!.init?.body).toBe(JSON.stringify({ reply: "always" }));
  });

  it("posts each question generation to its matching reply and reject endpoints", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch((url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => true } as Response;
    });
    await defaultOpenCodeHttpClient.replyQuestion(BASE, "ses_1", "que_1", [["Yes"]], "legacy");
    await defaultOpenCodeHttpClient.rejectQuestion(BASE, "ses_1", "que_2", "legacy");
    await defaultOpenCodeHttpClient.replyQuestion(BASE, "ses_1", "que_3", [["No"]], "v2");
    await defaultOpenCodeHttpClient.rejectQuestion(BASE, "ses_1", "que_4", "v2");
    expect(seen.map((entry) => entry.url)).toEqual([
      `${BASE}/question/que_1/reply`,
      `${BASE}/question/que_2/reject`,
      `${BASE}/api/session/ses_1/question/que_3/reply`,
      `${BASE}/api/session/ses_1/question/que_4/reject`,
    ]);
    expect(seen[0]!.init?.body).toBe(JSON.stringify({ answers: [["Yes"]] }));
    expect(seen[2]!.init?.body).toBe(JSON.stringify({ answers: [["No"]] }));
  });

  it("treats only typed consumed requests as idempotent 404 replies", async () => {
    stubFetch((url) => ({
      ok: false,
      status: 404,
      json: async () => ({ _tag: url.includes("permission") ? "PermissionNotFoundError" : "QuestionNotFoundError" }),
    }) as Response);
    await defaultOpenCodeHttpClient.replyPermission(BASE, "ses_1", "per_gone", "reject", "v2");
    await defaultOpenCodeHttpClient.replyQuestion(BASE, "ses_1", "que_gone", [["No"]], "v2");
    await defaultOpenCodeHttpClient.rejectQuestion(BASE, "ses_1", "que_gone", "v2");
  });

  it("surfaces a typed missing reply session instead of resolving the card", async () => {
    stubFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "not found" }),
    }) as Response);
    await expect(defaultOpenCodeHttpClient.replyPermission(BASE, "ses_gone", "per_1", "once", "v2"))
      .rejects.toBeInstanceOf(OpenCodeReplySessionNotFoundError);
  });

  it("surfaces non-404 reply failures", async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    await expect(defaultOpenCodeHttpClient.replyPermission(BASE, "ses_1", "per_1", "once", "legacy"))
      .rejects.toThrow(/reply permission/i);
  });
});

describe("session status polling", () => {
  it("returns per-session status types for idle confirmation", async () => {
    stubFetch(() => okJson({ ses_1: { type: "busy" }, ses_2: { type: "idle" } }));
    const statuses = await defaultOpenCodeHttpClient.getSessionStatus(BASE);
    expect(statuses).toEqual({ ses_1: { type: "busy" }, ses_2: { type: "idle" } });
  });

  it("drops malformed entries and rejects broken payloads", async () => {
    stubFetch(() => okJson({ ses_1: { type: "idle" }, ses_2: "busy" }));
    expect(await defaultOpenCodeHttpClient.getSessionStatus(BASE)).toEqual({ ses_1: { type: "idle" } });

    stubFetch(() => okJson(["idle"]));
    await expect(defaultOpenCodeHttpClient.getSessionStatus(BASE)).rejects.toThrow(/malformed/i);

    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    await expect(defaultOpenCodeHttpClient.getSessionStatus(BASE)).rejects.toThrow(/session status/i);
  });

  it("bounds status entries and ignores oversized status keys", async () => {
    const statuses = Object.fromEntries([
      ["s".repeat(513), { type: "idle" }],
      ...Array.from({ length: 300 }, (_, index) => [`ses_${index}`, { type: "idle" }]),
    ]);
    stubFetch(() => okJson(statuses));
    const result = await defaultOpenCodeHttpClient.getSessionStatus(BASE);
    expect(Object.keys(result)).toHaveLength(255);
    expect(result["s".repeat(513)]).toBeUndefined();
  });

  it("times out and aborts a stalled status read", async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    await expect(defaultOpenCodeHttpClient.getSessionStatus(BASE, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
  });

  it("forwards caller cancellation to a status read", async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const pending = defaultOpenCodeHttpClient.getSessionStatus(BASE, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("SSE boundary", () => {
  it("accepts a coalesced oversized network chunk when each complete frame is bounded", async () => {
    const encoder = new TextEncoder();
    const chunk = Array.from(
      { length: 4 },
      (_, index) => `data: ${JSON.stringify({ type: "session.updated", properties: { index, padding: "x".repeat(70_000) } })}\n\n`,
    ).join("");
    expect(encoder.encode(chunk).byteLength).toBeGreaterThan(262_144);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    stubFetch(() => ({ ok: true, status: 200, body: stream }) as Response);
    const received: number[] = [];

    await defaultOpenCodeHttpClient.subscribeEvents(BASE, new AbortController().signal, (event) => {
      if (!event || typeof event !== "object" || Array.isArray(event) || !("properties" in event)) return;
      const properties = event.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties) || !("index" in properties)) return;
      if (typeof properties.index === "number") received.push(properties.index);
    });

    expect(received).toEqual([0, 1, 2, 3]);
  });

  it("rejects a delayed delimiter once the raw frame exceeds the buffer limit", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"type":"session.idle","padding":"${"x".repeat(250_000)}`));
        controller.enqueue(encoder.encode(`${"x".repeat(20_000)}"}\n\n`));
        controller.close();
      },
    });
    stubFetch(() => ({ ok: true, status: 200, body: stream }) as Response);
    const received: unknown[] = [];
    await defaultOpenCodeHttpClient.subscribeEvents(BASE, new AbortController().signal, (event) => received.push(event));
    expect(received).toEqual([{ type: "mcode.adapter.oversized-sse-frame", properties: {} }]);
  });
});
