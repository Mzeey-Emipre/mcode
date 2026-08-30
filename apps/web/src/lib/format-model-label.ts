import { CURSOR_CLI_MODEL_SNAPSHOT } from "@mcode/contracts";
import { findModelById, type ModelDefinition } from "./model-registry.js";
import { formatCursorCliModelId, isCursorCliModelId } from "./format-cursor-model-id.js";

/**
 * Convert a raw provider model identifier into a friendly label for display.
 *
 * Prefer {@link resolveModelDisplayLabel} when a provider catalog may be available;
 * this function is the last-resort formatter for unknown or retired model IDs.
 *
 * Examples:
 *   formatModelLabel("claude-opus-4-7")               // "Claude Opus 4.7"
 *   formatModelLabel("claude-sonnet-4-6")             // "Claude Sonnet 4.6"
 *   formatModelLabel("gpt-5.6-sol")                   // "GPT-5.6 Sol"
 *   formatModelLabel("composer-2.5-fast")              // "Composer 2.5 Fast"
 *   formatModelLabel("cursor-agent")                  // "Cursor"
 *   formatModelLabel("codex")                         // "Codex"
 */
const CLAUDE_PATTERN = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-.+)?$/;
const COMPOSER_PATTERN = /^composer-(\d+(?:\.\d+)?)(?:-(.+))?$/;

/** Strips CLI metadata like "(current, default)" from catalog labels for message footers. */
function normalizeProviderModelName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title-cases a single hyphenated word (e.g. "fast" -> "Fast"). */
function titleCaseWord(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function formatClaudeLabel(id: string): string | undefined {
  const match = id.match(CLAUDE_PATTERN);
  if (!match) return undefined;
  const [, tier, major, minor] = match;
  return `Claude ${titleCaseWord(tier)} ${major}.${minor}`;
}

function formatComposerLabel(id: string): string | undefined {
  const match = id.match(COMPOSER_PATTERN);
  if (!match) return undefined;
  const [, version, tier] = match;
  return tier ? `Composer ${version} ${titleCaseWord(tier)}` : `Composer ${version}`;
}

function formatSegmentLabel(id: string): string {
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length > 1) return segments.map(titleCaseWord).join(" ");
  return segments[0] ? titleCaseWord(segments[0]) : id;
}

function formatKnownModelLabel(id: string): string | undefined {
  if (id === "auto") return "Auto";
  return formatClaudeLabel(id) ?? formatComposerLabel(id);
}

/**
 * Resolves a human-readable model label using catalog, static registry, then heuristics.
 *
 * @param modelId - Raw model id stored on the message or thread.
 * @param options.catalog - Live provider models (e.g. from {@link useProviderModelsStore}).
 */
export function resolveModelDisplayLabel(
  modelId: string,
  options?: { catalog?: readonly ModelDefinition[] },
): string {
  const id = modelId.trim();
  if (!id) return "";

  const catalogHit = options?.catalog?.find((m) => m.id === id);
  if (catalogHit) return normalizeProviderModelName(catalogHit.label);

  const snapshotHit = CURSOR_CLI_MODEL_SNAPSHOT.find((m) => m.id === id);
  if (snapshotHit) return normalizeProviderModelName(snapshotHit.name);

  if (isCursorCliModelId(id)) {
    const cursorLabel = formatCursorCliModelId(id);
    if (cursorLabel) return cursorLabel;
  }

  const registryHit = findModelById(id);
  if (registryHit) return registryHit.label;

  return formatModelLabel(id);
}

/** Format a raw model identifier into a display label (registry and heuristics). */
export function formatModelLabel(modelId: string): string {
  const id = modelId.trim();
  if (!id) return "";

  const registryHit = findModelById(id);
  if (registryHit) return normalizeProviderModelName(registryHit.label);

  const knownLabel = formatKnownModelLabel(id);
  if (knownLabel) return knownLabel;

  // OpenAI-style ids (gpt-5.9-future) avoid truncating to "Gpt" via first-segment logic.
  if (/^gpt[-_]/i.test(id)) {
    return `GPT-${id.replace(/^gpt[-_]/i, "")}`;
  }

  if (id === "cursor-agent") return "Cursor";
  return formatSegmentLabel(id);
}
