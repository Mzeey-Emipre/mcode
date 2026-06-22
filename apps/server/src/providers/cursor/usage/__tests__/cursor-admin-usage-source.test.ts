import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  beforeEach(() => {
    fetchImpl.mockReset();
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
        teamMemberSpend: [{ apiPercentUsed: 10, composerPercentUsed: 30 }],
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
          pageSize: 1,
        }),
      }),
    );
  });

  it("returns empty usage for failed or malformed responses", async () => {
    const source = new CursorAdminUsageSource({
      apiKey: "key",
      usageEmail: "dev@example.com",
      fetchImpl,
      now,
    });

    fetchImpl.mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(source.fetch()).resolves.toEqual([]);

    now.mockReturnValue(1_000 + 15 * 60 * 1000 + 1);
    fetchImpl.mockResolvedValueOnce(okResponse({ bad: true }));
    await expect(source.fetch()).resolves.toEqual([]);
  });
});
