import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultOpenCodeHttpClient } from "../opencode-http-client.js";

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
