/**
 * Merges Markdown instruction sources for Cursor ACP turns: user `~/.cursor/AGENTS.md`,
 * repository `AGENTS.md`, and `.cursor/AGENTS.md` under the session working directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInfo } from "@mcode/contracts";

/** Reads a Markdown file when it exists and is non-empty after trim. */
function readOptionalMarkdownFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const text = readFileSync(filePath, "utf-8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Concatenates `AGENTS.md` and `.cursor/AGENTS.md` under the session cwd.
 *
 * @param cwd - Session working directory.
 * @returns Combined Markdown or `undefined` when both files are missing or empty.
 */
export function mergeCursorWorkspaceAgentMarkdown(cwd: string): string | undefined {
  const chunks: string[] = [];
  const repo = readOptionalMarkdownFile(join(cwd, "AGENTS.md"));
  if (repo) chunks.push(repo);
  const project = readOptionalMarkdownFile(join(cwd, ".cursor", "AGENTS.md"));
  if (project) chunks.push(project);
  if (chunks.length === 0) return undefined;
  return chunks.join("\n\n---\n\n");
}

const MAX_AGENT_GUIDANCE_CHARS = 48_000;
const MAX_SKILL_COMMAND_ROWS = 200;
const PER_SKILL_DESC_CHARS = 400;

/** Truncates stitched AGENTS content so catastrophic repo rules files cannot saturate input. */
function capAgentMarkdown(markdown: string): string {
  if (markdown.length <= MAX_AGENT_GUIDANCE_CHARS) return markdown;
  const dropped = markdown.length - MAX_AGENT_GUIDANCE_CHARS;
  return `${markdown.slice(0, MAX_AGENT_GUIDANCE_CHARS)}\n\n[AGENTS.md excerpt truncated (${dropped} characters dropped)]`;
}

/**
 * Builds layered agent instructions for Cursor: global user rules (`~/.cursor/AGENTS.md`),
 * then workspace {@link mergeCursorWorkspaceAgentMarkdown}.
 *
 * @param cwd - Session working directory (composer branch or worktree root).
 * @returns Combined Markdown or `undefined` when no files are readable.
 */
export function buildCursorAgentGuidanceMarkdown(cwd: string): string | undefined {
  const chunks: string[] = [];
  const user = readOptionalMarkdownFile(join(homedir(), ".cursor", "AGENTS.md"));
  if (user) chunks.push(user);
  const workspace = mergeCursorWorkspaceAgentMarkdown(cwd);
  if (workspace) chunks.push(workspace);
  if (chunks.length === 0) return undefined;
  return capAgentMarkdown(chunks.join("\n\n---\n\n"));
}

/**
 * Formats skill and command metadata into an XML-ish prompt section so the Cursor
 * agent knows which toolbox entries apply for this workspace.
 *
 * Keeps prompts bounded because large installs can expose hundreds of skills.
 *
 * @param items - Skills and commands from `SkillService.list(cwd, "cursor")`.
 */
export function formatCursorSkillsAndCommandsForPrompt(
  items: readonly SkillInfo[],
): string | undefined {
  if (items.length === 0) return undefined;
  const rows = items.slice(0, MAX_SKILL_COMMAND_ROWS);
  const truncatedCount = items.length - rows.length;
  const lines = rows.map((i) => {
    const tag = i.kind === "command" ? "command" : "skill";
    const desc =
      i.description.length > PER_SKILL_DESC_CHARS
        ? `${i.description.slice(0, PER_SKILL_DESC_CHARS)}…`
        : i.description;
    return `- [${tag}] ${i.name}: ${desc}`;
  });
  if (truncatedCount > 0) {
    lines.push(
      `- … and ${truncatedCount} additional skill/command entries omitted here (browse the Composer skills picker in Mcode)`,
    );
  }
  return [
    "<available-skills-and-commands>",
    "Discovered Cursor provider skills and commands (user and project .cursor trees).",
    ...lines,
    "</available-skills-and-commands>",
  ].join("\n");
}
