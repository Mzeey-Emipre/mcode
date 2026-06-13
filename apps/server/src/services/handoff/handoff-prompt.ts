/**
 * Builds the side-channel prompt that the parent's provider session executes
 * to produce a handoff document. Vendors the /handoff skill instructions and
 * tailors them with fork context.
 *
 * PRD #538 retired the full-vs-minimal mode selection, the child-input
 * character budget, and the >115% truncation/overflow guard. Most providers
 * read the full doc from an OS temp file via a one-shot ScopedPreGrant.
 * Providers without that read path may receive the bounded artifact inline.
 * The prompt therefore asks for a complete, self-contained document with no
 * character cap unless the child provider cannot read the off-band artifact.
 */

import type { ForkAnchorRole } from "./handoff-types.js";

/** Input arguments for building the handoff prompt sent to the parent provider session. */
export interface HandoffPromptInput {
  forkAnchorRole: ForkAnchorRole;
  parentThreadTitle: string;
  forkMessageExcerpt: string;
  childProviderId: string;
  /**
   * The user's new follow-up message in the fork composer. Passed to the
   * side-channel so the prompt can tell the model what the child agent is
   * about to be asked, enabling targeted context preservation.
   */
  userFollowUpMessage: string;
}

/**
 * Builds the prompt sent to the parent's provider session to produce the
 * handoff doc. The provider RETURNS the markdown as its assistant text; mcode
 * writes the file itself via HandoffStorage.write(). The side-channel call
 * passes `tools: []`, so the model must not be asked to write files.
 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const { forkAnchorRole, parentThreadTitle, forkMessageExcerpt, childProviderId, userFollowUpMessage } = input;

  const anchorFraming =
    forkAnchorRole === "user"
      ? "The user is forking from their own message. They want to retry this question, potentially with different framing or to a different provider."
      : "The user is forking from the assistant's reply. They are asking a follow-up about what the assistant just said.";

  // The "argument" the /handoff skill is designed to receive: what the next
  // session will focus on. When the user has typed a follow-up message in the
  // fork composer, that's the argument. When they haven't, we tell the skill
  // explicitly so it knows to hand off the full context.
  const argumentBlock = userFollowUpMessage.trim().length > 0
    ? `The user's follow-up message in the new branched thread (treat this as the skill's "arguments", the description of what the next session will focus on): "${userFollowUpMessage.slice(0, 800)}"`
    : "The user has not provided a follow-up message yet (no skill arguments). Hand off the full context up to the fork point so the next agent is prepared for any direction the user takes.";
  const deliveryConstraint = childProviderId === "codex"
    ? "- Write a complete, self-contained document under 12,000 characters because Codex receives this handoff inline. Prefer the details needed for the follow-up over exhaustive history."
    : "- Write a complete, self-contained document. There is no character cap: mcode delivers the full doc to the next agent off-band (written to a file the agent reads on demand), so prefer completeness over brevity while staying focused on what matters for the follow-up.";

  return [
    "You are executing the /handoff skill on the conversation up to the fork point. Below are the skill's instructions verbatim, followed by mcode-specific context.",
    "",
    "## /handoff skill instructions",
    "",
    "Write a handoff document summarising the current conversation so a fresh agent can continue the work.",
    "",
    `Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.`,
    "",
    "Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.",
    "",
    "Redact any sensitive information, such as API keys, passwords, or personally identifiable information.",
    "",
    "If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.",
    "",
    "## Context for this handoff",
    `- Parent thread title: ${parentThreadTitle}`,
    `- Fork anchor (${forkAnchorRole} message): ${forkMessageExcerpt.slice(0, 600)}`,
    `- ${anchorFraming}`,
    `- Next agent's provider: ${childProviderId}`,
    "",
    "## Arguments",
    argumentBlock,
    "",
    "## Output constraints (mcode-specific)",
    deliveryConstraint,
    "- Return the complete handoff document as your assistant text response.",
    "- Do NOT call any tools. Do NOT write to disk. mcode handles persistence.",
    "- Do NOT include YAML frontmatter (the pipeline injects that).",
    "- Begin your response directly with the document's first heading.",
  ].join("\n");
}
