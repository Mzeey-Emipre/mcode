/**
 * Prompt assembly for `cursor-agent --print`. Cursor exposes no `--system` or
 * `--instructions` flag; user-scope guidance from `~/.cursor/AGENTS.md` is
 * prepended here so each turn receives it alongside workspace-local discovery.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AttachmentMeta } from "@mcode/contracts";
import { isVirtualBrowserContextAttachment } from "@mcode/contracts";

/**
 * Reads trimmed contents of `~/.cursor/AGENTS.md` when that file exists.
 *
 * @returns File contents or `undefined` when missing or unreadable.
 */
export function readCursorUserInstructions(): string | undefined {
  const path = join(homedir(), ".cursor", "AGENTS.md");
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf-8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds prompt text from optional user instructions, attachment references, and the message.
 *
 * Images become explicit paths; non-images become labelled mentions without raw FS paths.
 *
 * @param message User-visible message body for this turn.
 * @param attachments Optional attachment metadata from the composer.
 * @param userInstructions Optional extra instructions (typically from {@link readCursorUserInstructions}).
 */
export function buildCursorPrompt(
  message: string,
  attachments?: AttachmentMeta[],
  userInstructions?: string,
): string {
  const lines: string[] = [];
  const trimmedInstructions = userInstructions?.trim();
  if (trimmedInstructions) {
    lines.push(`<user-instructions>\n${trimmedInstructions}\n</user-instructions>`);
  }
  for (const att of attachments ?? []) {
    if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
    if (att.mimeType.startsWith("image/")) {
      lines.push(`[Attached image path: ${att.sourcePath}]`);
    } else {
      const safeName = att.name.replace(/[\x00-\x1f\x7f]/g, "");
      const safeMime = att.mimeType.replace(/[\x00-\x1f\x7f]/g, "");
      lines.push(`[Attached file: ${safeName} (${safeMime})]`);
    }
  }
  lines.push(message);
  return lines.join("\n\n");
}
