/**
 * Fetches available Claude models from the Anthropic REST API.
 *
 * Returns ProviderModelInfo[] with contextWindow populated from
 * max_input_tokens. Results are cached in-memory with a 5-minute TTL
 * to avoid hammering the API on repeated model selector hovers.
 */

import { logger } from "@mcode/shared";
import type { ProviderModelInfo } from "@mcode/contracts";

/** Cache TTL: 5 minutes, matching the design spec. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Opus 5 metadata available even when the Anthropic Models API cannot be queried. */
const OPUS_5_FALLBACK: ProviderModelInfo = {
  id: "claude-opus-5",
  name: "Claude Opus 5",
  contextWindow: 1_000_000,
  supportsReasoning: true,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  defaultReasoningEffort: "high",
};

/** Shape of a single model from the Anthropic Models API. */
interface AnthropicModelInfo {
  id: string;
  display_name: string;
  type: string;
  max_input_tokens: number | null;
  max_tokens: number | null;
}

/** Paginated response from GET /v1/models. */
interface AnthropicModelsResponse {
  data: AnthropicModelInfo[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

let cachedModels: ProviderModelInfo[] | null = null;
let cacheTimestamp = 0;
let inflight: Promise<ProviderModelInfo[]> | null = null;

/** Adds Opus 5 capability metadata while preserving every model returned by the API. */
function mergeOpus5Fallback(models: ProviderModelInfo[]): ProviderModelInfo[] {
  const opus5 = models.find((model) => model.id === OPUS_5_FALLBACK.id);
  const otherModels = models.filter((model) => model.id !== OPUS_5_FALLBACK.id);
  return [{ ...OPUS_5_FALLBACK, ...opus5 }, ...otherModels];
}

/**
 * Resets the in-memory model cache and any inflight request.
 *
 * Exposed for testing to ensure a clean state between test runs. Not intended
 * for production use; the TTL-based expiry handles normal cache invalidation.
 */
export function resetModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
  inflight = null;
}

/**
 * Performs the actual network request to the Anthropic Models API.
 *
 * Populates the in-memory cache on success. Does not guard against
 * concurrent callers — use listClaudeModels() which coalesces inflight
 * requests onto a single promise.
 */
async function fetchModels(): Promise<ProviderModelInfo[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // The Claude Agent SDK uses its own auth mechanism, so this env var
    // is often absent. Return empty and let the static registry provide
    // model data instead of surfacing an error to the user.
    logger.debug("ANTHROPIC_API_KEY not set, skipping models API fetch");
    return [OPUS_5_FALLBACK];
  }

  // limit=100 covers all current Claude models without pagination.
  // Anthropic has far fewer than 100 Claude models at present, so we
  // intentionally do not follow has_more / last_id pagination.
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Anthropic Models API returned ${res.status} ${res.statusText}`,
    );
  }

  const body = (await res.json()) as AnthropicModelsResponse;

  const models = mergeOpus5Fallback(body.data
    .filter((m) => m.id.startsWith("claude-"))
    .map((m) => ({
      id: m.id,
      name: m.display_name,
      contextWindow: m.max_input_tokens ?? undefined,
    })));

  cachedModels = models;
  cacheTimestamp = Date.now();

  logger.debug("Fetched Claude models from API", { count: models.length });

  return models;
}

/**
 * Fetch Claude models from the Anthropic REST API.
 *
 * Reads `ANTHROPIC_API_KEY` from the environment (same var the Claude
 * Agent SDK uses). Filters to `claude-*` models and maps each to
 * `ProviderModelInfo` with `contextWindow` from `max_input_tokens`.
 *
 * Results are cached for CACHE_TTL_MS. Concurrent callers during a
 * cache miss share a single inflight promise to prevent stampedes.
 */
export async function listClaudeModels(): Promise<ProviderModelInfo[]> {
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }
  if (inflight) return inflight;

  inflight = fetchModels().finally(() => {
    inflight = null;
  });
  return inflight;
}
