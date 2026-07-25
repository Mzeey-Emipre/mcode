import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProviderModelInfo } from "@mcode/contracts";
import { listClaudeModels, resetModelCache } from "../list-models.js";

// Minimal shape matching the Anthropic Models API response.
const MOCK_API_RESPONSE = {
  data: [
    {
      id: "claude-sonnet-4-6-20250514",
      display_name: "Claude Sonnet 4.6",
      type: "model",
      max_input_tokens: 1_000_000,
      max_tokens: 16_384,
    },
    {
      id: "claude-haiku-4-5-20251001",
      display_name: "Claude Haiku 4.5",
      type: "model",
      max_input_tokens: 200_000,
      max_tokens: 8_192,
    },
    {
      id: "some-non-claude-model",
      display_name: "Not Claude",
      type: "model",
      max_input_tokens: 128_000,
      max_tokens: 4_096,
    },
  ],
  has_more: false,
};

describe("listClaudeModels", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-123";
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_API_RESPONSE),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    }
    vi.unstubAllGlobals();
    resetModelCache();
  });

  it("returns ProviderModelInfo[] filtered to claude models", async () => {
    const result = await listClaudeModels();
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual<ProviderModelInfo>({
      id: "claude-opus-5",
      name: "Claude Opus 5",
      contextWindow: 1_000_000,
      supportsReasoning: true,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    expect(result[1]).toEqual<ProviderModelInfo>({
      id: "claude-sonnet-4-6-20250514",
      name: "Claude Sonnet 4.6",
      contextWindow: 1_000_000,
    });
    expect(result[2]).toEqual<ProviderModelInfo>({
      id: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      contextWindow: 200_000,
    });
  });

  it("sends the correct headers", async () => {
    await listClaudeModels();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models?limit=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "test-key-123",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("returns the Opus 5 fallback when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await listClaudeModels();
    expect(result).toEqual<ProviderModelInfo[]>([
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        contextWindow: 1_000_000,
        supportsReasoning: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "high",
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-OK response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });
    await expect(listClaudeModels()).rejects.toThrow("401");
  });

  it("returns cached result on second call without re-fetching", async () => {
    await listClaudeModels();
    await listClaudeModels();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    await listClaudeModels();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60 * 1001);
    await listClaudeModels();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    dateSpy.mockRestore();
  });

  it("coalesces concurrent cache-miss requests into a single fetch", async () => {
    const [a, b] = await Promise.all([listClaudeModels(), listClaudeModels()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // same array reference from the shared promise
  });
});
