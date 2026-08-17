import type { DiffPayload } from "./diff-summary-source.js";

/**
 * Builds the XML-tagged prompt for diff summary generation.
 *
 * Structures context in named XML sections (role, rules, mermaid-syntax,
 * workflow, diff-stats, diff, commits) so the utility model can parse
 * each concern independently. The mermaid-syntax section explicitly
 * teaches the model to use <br> instead of \n for node label line breaks,
 * which prevents mermaid parse errors in the rendered output.
 */
export function buildDiffSummaryPrompt(payload: DiffPayload): string {
  const statsTable = payload.stats
    .map((s) => `${s.filePath}  +${s.additions}/-${s.deletions}`)
    .join("\n");

  const diffSection =
    payload.diff.length > 0
      ? payload.diff
      : "No detailed diff available. Summarize from stats and commit messages.";

  const commitsSection =
    payload.commits.length > 0
      ? payload.commits
      : "No commit messages available.";

  return `<role>
You are a code change analyst. Produce a concise summary of the
changes described below. Be direct. No filler.
</role>

<rules>
- Group changes by logical concern, not by file
- Flag risk areas or incomplete work
- Use mermaid diagrams to illustrate relationships, flows, or
  architecture changes when they add clarity. Not every summary
  needs a diagram.
- Keep total output under 800 words
</rules>

<mermaid-syntax>
When writing mermaid blocks:
- Use <br> for line breaks inside node labels, NEVER use \\n
- Wrap labels with special characters in quotes: A["Label (here)"]
- Always declare node IDs before referencing them in edges
- Stick to graph TD, sequenceDiagram, or flowchart LR
- Test mentally: if a label has parentheses, brackets, or colons,
  it MUST be quoted
</mermaid-syntax>

<workflow>
1. Read the diff stats to understand scope (files changed, scale)
2. Read the unified diff for detail (if provided; may be partial for large changesets)
3. Read commit messages for intent
4. Write a narrative summary grouped by concern
5. If architecture or data flow changed, include ONE mermaid diagram
6. List risk areas or incomplete items, if any
7. End with an aggregate stat line (files, insertions, deletions)
</workflow>

<diff-stats>
${statsTable}
</diff-stats>

<diff>
${diffSection}
</diff>

<commits>
${commitsSection}
</commits>`;
}
