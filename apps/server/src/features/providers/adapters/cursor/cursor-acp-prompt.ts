/**
 * Builds ACP {@link ContentBlock} arrays for Cursor from composer text, optional
 * attachments, and user-scope instructions (same sources as {@link buildCursorPrompt}).
 */

import { readFileSync } from "node:fs";
import type { AttachmentMeta } from "@mcode/contracts";
import { isVirtualBrowserContextAttachment } from "@mcode/contracts";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  buildCursorPrompt,
  readCursorUserInstructions,
} from "./cursor-prompt.js";

/**
 * Assembles prompt blocks for `session/prompt`, embedding images when readable
 * from disk; non-image attachments stay as inline text notes without raw paths.
 *
 * @param message - User-visible message for this turn (may include branch replay text).
 * @param attachments - Persisted attachment metadata with `sourcePath` for images.
 * @param userInstructions - Precomposed instructions string (layered AGENTS files, skill index).
 * When omitted, falls back to {@link readCursorUserInstructions} (~/.cursor/AGENTS.md only).
 */
export function buildCursorAcpPromptBlocks(
  message: string,
  attachments?: AttachmentMeta[],
  userInstructions?: string,
): ContentBlock[] {
  const instructions = userInstructions ?? readCursorUserInstructions();
  const blocks: ContentBlock[] = [];
  const unreadableNotes: string[] = [];

  const nonImageAttachments =
    attachments?.filter(
      (att) =>
        !att.mimeType.startsWith("image/") && !isVirtualBrowserContextAttachment(att.mimeType),
    ) ?? [];

  for (const att of attachments ?? []) {
    if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
    if (!att.mimeType.startsWith("image/")) continue;
    try {
      const buf = readFileSync(att.sourcePath);
      blocks.push({
        type: "image",
        mimeType: att.mimeType,
        data: buf.toString("base64"),
      });
    } catch {
      unreadableNotes.push(
        `[Attached image unreadable: ${att.name.replace(/[\x00-\x1f\x7f]/g, "")}]`,
      );
    }
  }

  const textBody = buildCursorPrompt(message, nonImageAttachments, instructions);
  blocks.push({
    type: "text",
    text:
      unreadableNotes.length > 0
        ? `${unreadableNotes.join("\n\n")}\n\n${textBody}`
        : textBody,
  });
  return blocks;
}
