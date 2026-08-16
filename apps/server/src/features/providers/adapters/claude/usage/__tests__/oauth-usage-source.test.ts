import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicOAuthUsageSource } from "../oauth-usage-source.js";

const okResponse = (body: object): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("AnthropicOAuthUsageSource", () => {
  const readToken = vi.fn();

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockReset();
    readToken.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("maps five_hour and seven_day to QuotaCategory[]", async () => {
    readToken.mockResolvedValue({ accessToken: "tok", expiresAt: Date.now() + 60_000 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        five_hour: { utilization: 42, resets_at: "2026-04-28T19:00:00Z" },
        seven_day: { utilization: 18, resets_at: "2026-05-03T00:00:00Z" },
        extra_usage: { used_cents: 0, utilization: 0 },
      }),
    );

    const source = new AnthropicOAuthUsageSource(readToken);
    const result = await source.fetch();

    expect(result).toEqual([
      {
        label: "5-hour limit",
        used: 42,
        total: 100,
        isUnlimited: false,
        remainingPercent: 0.58,
        resetDate: "2026-04-28T19:00:00Z",
      },
      {
        label: "Weekly limit",
        used: 18,
        total: 100,
        isUnlimited: false,
        remainingPercent: 0.82,
        resetDate: "2026-05-03T00:00:00Z",
      },
    ]);
  });

  it("appends a Pay-as-you-go row when used_cents > 0", async () => {
    readToken.mockResolvedValue({ accessToken: "tok", expiresAt: Date.now() + 60_000 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        five_hour: { utilization: 10, resets_at: "x" },
        seven_day: { utilization: 5, resets_at: "y" },
        extra_usage: { used_cents: 250, utilization: 0 },
      }),
    );
    const result = await new AnthropicOAuthUsageSource(readToken).fetch();
    expect(result?.[2]).toEqual({
      label: "Pay-as-you-go",
      used: 2.5,
      total: null,
      isUnlimited: true,
      remainingPercent: 1,
    });
  });

  it("returns null on 401 and re-reads token on next call", async () => {
    readToken.mockResolvedValue({ accessToken: "tok", expiresAt: Date.now() + 60_000 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("", { status: 401 }),
    );
    const source = new AnthropicOAuthUsageSource(readToken);
    expect(await source.fetch()).toBeNull();
    // After 401, next fetch re-reads the token (readToken called again).
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({ five_hour: { utilization: 1, resets_at: "z" }, seven_day: { utilization: 1, resets_at: "z" }, extra_usage: { used_cents: 0, utilization: 0 } }),
    );
    await source.fetch();
    expect(readToken).toHaveBeenCalledTimes(2);
  });

  it("returns null on 5xx without re-reading the token next call", async () => {
    readToken.mockResolvedValue({ accessToken: "tok", expiresAt: Date.now() + 60_000 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("", { status: 503 }),
    );
    const source = new AnthropicOAuthUsageSource(readToken);
    expect(await source.fetch()).toBeNull();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({ five_hour: { utilization: 1, resets_at: "z" }, seven_day: { utilization: 1, resets_at: "z" }, extra_usage: { used_cents: 0, utilization: 0 } }),
    );
    await source.fetch();
    expect(readToken).toHaveBeenCalledTimes(1);
  });

  it("returns null when the token reader returns null", async () => {
    readToken.mockResolvedValue(null);
    const source = new AnthropicOAuthUsageSource(readToken);
    expect(await source.fetch()).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("caches a valid token across multiple fetch calls", async () => {
    readToken.mockResolvedValue({ accessToken: "tok", expiresAt: Date.now() + 60_000 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        five_hour: { utilization: 1, resets_at: "z" },
        seven_day: { utilization: 1, resets_at: "z" },
        extra_usage: { used_cents: 0, utilization: 0 },
      }),
    );
    const source = new AnthropicOAuthUsageSource(readToken);
    await source.fetch();
    await source.fetch();
    // Token was valid and unexpired — readToken should only be called once.
    expect(readToken).toHaveBeenCalledTimes(1);
  });

  it("re-reads token when the cached token is expired", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        five_hour: { utilization: 1, resets_at: "z" },
        seven_day: { utilization: 1, resets_at: "z" },
        extra_usage: { used_cents: 0, utilization: 0 },
      }),
    );
    // First call returns an already-expired token; second returns a fresh one.
    readToken
      .mockResolvedValueOnce({ accessToken: "stale", expiresAt: Date.now() - 1 })
      .mockResolvedValueOnce({ accessToken: "fresh", expiresAt: Date.now() + 60_000 });

    const source = new AnthropicOAuthUsageSource(readToken);
    await source.fetch(); // stale token → re-read each call until a fresh one is stored
    await source.fetch(); // fresh token cached — no further re-read
    await source.fetch(); // served from cache
    // readToken called twice: once for the expired token, once for the fresh one.
    expect(readToken).toHaveBeenCalledTimes(2);
  });
});
