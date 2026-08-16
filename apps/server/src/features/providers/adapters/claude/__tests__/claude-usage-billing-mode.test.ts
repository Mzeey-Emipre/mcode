import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

import { ClaudeProvider } from "../claude-provider.js";

function provider(): ClaudeProvider {
  return new ClaudeProvider(
    { getEnv: () => ({}) } as any,
    { addProcess: () => {}, removeProcess: () => {}, killAll: async () => {} } as any,
  );
}

function withUsageSources(
  claude: ClaudeProvider,
  {
    oauthAvailable,
    categories = [],
  }: {
    oauthAvailable: boolean;
    categories?: Awaited<ReturnType<ClaudeProvider["getUsage"]>>["quotaCategories"];
  },
): ClaudeProvider {
  (claude as any).oauthUsageSource = {
    isAvailable: vi.fn().mockResolvedValue(oauthAvailable),
  };
  (claude as any).usageSource = {
    fetch: vi.fn().mockResolvedValue(categories),
  };
  return claude;
}

describe("ClaudeProvider usage billing mode", () => {
  it("marks OAuth usage as plan even when session cost exists", async () => {
    const claude = withUsageSources(provider(), { oauthAvailable: true });
    (claude as any).lastSessionCostUsd = 12.34;

    await expect(claude.getUsage()).resolves.toMatchObject({
      providerId: "claude",
      billingMode: "plan",
      sessionCostUsd: 12.34,
    });
  });

  it("marks finite session cost without OAuth as API-key usage", async () => {
    const claude = withUsageSources(provider(), { oauthAvailable: false });
    (claude as any).lastSessionCostUsd = 12.34;

    await expect(claude.getUsage()).resolves.toMatchObject({
      providerId: "claude",
      billingMode: "api_key",
      sessionCostUsd: 12.34,
    });
  });

  it("marks usage as unknown when OAuth is absent and session cost is missing", async () => {
    const claude = withUsageSources(provider(), { oauthAvailable: false });

    await expect(claude.getUsage()).resolves.toMatchObject({
      providerId: "claude",
      billingMode: "unknown",
    });
  });
});
