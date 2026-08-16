/**
 * Sticky preamble handling for Cursor ACP turns: oversized guidance + skill
 * indices were previously re-inserted every `session/prompt`, inflating repeat
 * input tokens despite the Cursor session retaining prior prompts.
 */

/** At or above this size, payload is treated as a heavy preamble duplicated only once per session. */
export const CURSOR_INSTRUCTIONS_HEAVY_THRESHOLD_CHARS = 2500;

/**
 * Lightweight reminder substituted after heavy instructions shipped once within
 * this subprocess + Cursor SDK session pairing.
 */
export const CURSOR_INSTRUCTIONS_RESUME_HINT_TEXT = [
  "Session preamble reminder: layered AGENTS.md (user ~/.cursor plus workspace)",
  "and the discovered skills/commands catalogue from the start of this session still apply.",
  "Follow those rules unless contradicted explicitly in this prompt.",
].join(" ");

/** Reads `~/.cursor/AGENTS.md` when callers pass no layered guidance/skills markdown. */
export type CursorAgentsFallbackReader = () => string | undefined;

/**
 * Computes the `<user-instructions>` body for one ACP prompt and whether we
 * should mark sticky state after sending (heavy payloads only).
 */
export function resolveCursorStickyInstructionBlob(opts: {
  combinedGuidanceAndSkillsMarkdown: string | undefined;
  readFallbackAgents: CursorAgentsFallbackReader;
  stickyHeavyCommitted: boolean;
}): {
  instructionMarkdown: string | undefined;
  markHeavyCommitted: boolean;
} {
  let base = opts.combinedGuidanceAndSkillsMarkdown?.trim() ?? "";

  const fallbackTrimmed = (): string => opts.readFallbackAgents()?.trim() ?? "";

  if (!base) {
    base = fallbackTrimmed();
  }

  if (!base) {
    return { instructionMarkdown: undefined, markHeavyCommitted: false };
  }

  const heavy = base.length >= CURSOR_INSTRUCTIONS_HEAVY_THRESHOLD_CHARS;

  if (opts.stickyHeavyCommitted && heavy) {
    return {
      instructionMarkdown: CURSOR_INSTRUCTIONS_RESUME_HINT_TEXT,
      markHeavyCommitted: false,
    };
  }

  return {
    instructionMarkdown: base,
    markHeavyCommitted: heavy,
  };
}
