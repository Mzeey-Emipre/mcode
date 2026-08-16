import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@mcode/shared";
import {
  CursorAdminUsageSource,
  mapCursorSpendMember,
} from "../cursor-admin-usage-source.js";

const okResponse = (body: object): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("mapCursorSpendMember", () => {
  it("maps API and Auto percentages to quota categories", () => {
    expect(mapCursorSpendMember({ apiPercentUsed: 63, autoPercentUsed: 21 })).toEqual([
      {
        label: "API usage",
        used: 63,
        total: 100,
        remainingPercent: 0.37,
        isUnlimited: false,
      },
      {
        label: "Auto and Composer",
        used: 21,
        total: 100,
        remainingPercent: 0.79,
        isUnlimited: false,
      },
    ]);
  });

  it("falls back to total usage when specific percentages are absent", () => {
    expect(mapCursorSpendMember({ totalPercentUsed: 44 })).toEqual([
      {
        label: "Total usage",
        used: 44,
        total: 100,
        remainingPercent: 0.56,
        isUnlimited: false,
      },
    ]);
  });
});

describe("CursorAdminUsageSource", () => {
  const fetchImpl = vi.fn();
  const now = vi.fn();
  let warnMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchImpl.mockReset();
    warnMock = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    now.mockReturnValue(1_000);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns empty usage when API key is missing", async () => {
    const source = new CursorAdminUsageSource({
      apiKey: "",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns empty usage when usage email is missing", async () => {
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and caches Cursor usage percentages", async () => {
    fetchImpl.mockResolvedValue(
      okResponse({
        teamMemberSpend: [{ email: "dev@example.com", apiPercentUsed: 10, composerPercentUsed: 30 }],
      }),
    );
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([
      {
        label: "API usage",
        used: 10,
        total: 100,
        remainingPercent: 0.9,
        isUnlimited: false,
      },
      {
        label: "Auto and Composer",
        used: 30,
        total: 100,
        remainingPercent: 0.7,
        isUnlimited: false,
      },
    ]);
    await source.fetch();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.cursor.com/teams/spend",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          searchTerm: "dev@example.com",
          page: 1,
          pageSize: 10,
        }),
      }),
    );
  });

  it("supports async API key and usage email resolution", async () => {
    fetchImpl.mockResolvedValue(
      okResponse({
        teamMemberSpend: [{ email: "dev@example.com", totalPercentUsed: 42 }],
      }),
    );
    const source = new CursorAdminUsageSource({
      apiKey: async () => "key",
      usageEmail: async () => "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([
      {
        label: "Total usage",
        used: 42,
        total: 100,
        remainingPercent: 0.58,
        isUnlimited: false,
      },
    ]);
  });

  it("does not reuse cached usage after the configured email changes", async () => {
    let usageEmail = "first@example.com";
    fetchImpl
      .mockResolvedValueOnce(
        okResponse({
          teamMemberSpend: [{ email: "first@example.com", apiPercentUsed: 10 }],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          teamMemberSpend: [{ email: "second@example.com", apiPercentUsed: 20 }],
        }),
      );
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: () => usageEmail,
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([
      {
        label: "API usage",
        used: 10,
        total: 100,
        remainingPercent: 0.9,
        isUnlimited: false,
      },
    ]);

    usageEmail = "second@example.com";

    await expect(source.fetch()).resolves.toEqual([
      {
        label: "API usage",
        used: 20,
        total: 100,
        remainingPercent: 0.8,
        isUnlimited: false,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent first fetches", async () => {
    let resolveResponse: (response: Response) => void = () => {};
    fetchImpl.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    const first = source.fetch();
    const second = source.fetch();
    resolveResponse(okResponse({
      teamMemberSpend: [{ email: "dev@example.com", apiPercentUsed: 12 }],
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        {
          label: "API usage",
          used: 12,
          total: 100,
          remainingPercent: 0.88,
          isUnlimited: false,
        },
      ],
      [
        {
          label: "API usage",
          used: 12,
          total: 100,
          remainingPercent: 0.88,
          isUnlimited: false,
        },
      ],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("matches the configured usage email exactly across multiple members", async () => {
    fetchImpl.mockResolvedValue(
      okResponse({
        teamMemberSpend: [
          { email: "other@example.com", apiPercentUsed: 99 },
          { userEmail: " Dev@Example.com ", apiPercentUsed: 12 },
        ],
      }),
    );
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([
      {
        label: "API usage",
        used: 12,
        total: 100,
        remainingPercent: 0.88,
        isUnlimited: false,
      },
    ]);
  });

  it("does not guess from a fuzzy or wrong first team member result", async () => {
    fetchImpl.mockResolvedValue(
      okResponse({
        teamMemberSpend: [
          { email: "dev+other@example.com", apiPercentUsed: 99 },
          { email: "other@example.com", apiPercentUsed: 12 },
        ],
      }),
    );
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([]);
  });

  it.each([401, 403, 429])("returns empty usage for HTTP %s", async (status) => {
    fetchImpl.mockResolvedValue(new Response("", { status }));
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([]);
    expect(warnMock).toHaveBeenCalledWith("Cursor usage unavailable", {
      reason: "http_status",
      status,
    });
  });

  it("returns empty usage for rejected requests", async () => {
    fetchImpl.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([]);
    expect(warnMock).toHaveBeenCalledWith("Cursor usage unavailable", {
      reason: "request_failed",
      error: "TimeoutError",
    });
  });

  it("returns empty usage for malformed JSON and malformed shapes", async () => {
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    fetchImpl.mockResolvedValueOnce(new Response("{", { status: 200 }));
    await expect(source.fetch()).resolves.toEqual([]);

    now.mockReturnValue(1_000 + 15 * 60 * 1000 + 1);
    fetchImpl.mockResolvedValueOnce(okResponse({ bad: true }));
    await expect(source.fetch()).resolves.toEqual([]);
  });

  it("rejects oversized responses before parsing", async () => {
    fetchImpl.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(64 * 1024 + 1) },
      }),
    );
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await expect(source.fetch()).resolves.toEqual([]);
    expect(warnMock).toHaveBeenCalledWith("Cursor usage unavailable", {
      reason: "response_too_large",
    });
  });

  it("does not log API keys, Authorization headers, raw responses, or user email", async () => {
    fetchImpl.mockResolvedValue(new Response("", { status: 403 }));
    const source = new CursorAdminUsageSource({
      apiKey: "secret-api-key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    await source.fetch();

    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).not.toContain("secret-api-key");
    expect(logged).not.toContain("Authorization");
    expect(logged).not.toContain("Basic");
    expect(logged).not.toContain("dev@example.com");
  });
});
