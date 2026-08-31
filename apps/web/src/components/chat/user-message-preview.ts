import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts";
import { stripInjectedFiles } from "@/lib/file-tags";
import type { Message } from "@/transport";

/**
 * Detect a user-typed /goal SET form (`/goal <condition>` with non-empty,
 * non-control argument). Mirrors the user-side branch in MessageBubble.
 */
function parseUserGoalCommand(content: string): { condition: string } | null {
  const m = /^\s*\/goal\b\s*([\s\S]*)$/.exec(content);
  if (!m) return null;
  const arg = m[1].trim();
  if (arg === "") return null;
  const lower = arg.toLowerCase();
  if (lower === "clear" || lower === "reset" || lower === "show") return null;
  return { condition: arg };
}

/** Collapses markdown noise so sticky previews stay readable in one or two lines. */
function toPlainPreview(text: string): string {
  const codeBlocks = [...text.matchAll(/```[\w-]*\n?([\s\S]*?)```/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);

  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#*_>~[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (plain) return plain;

  if (codeBlocks.length > 0) {
    const firstLine = codeBlocks[0]?.split("\n").find((line) => line.trim())?.trim();
    if (firstLine) {
      return firstLine.length > 120 ? `[Code] ${firstLine.slice(0, 120)}…` : `[Code] ${firstLine}`;
    }
    return "[Code snippet]";
  }

  return "";
}

/** Returns true when the sticky preview should offer an expand control. */
export function isStickyPreviewExpandable(preview: string): boolean {
  return preview.length > 140;
}

function pluralAttachmentLabel(count: number, noun: "image" | "file"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function imageAttachmentPreview(images: NonNullable<Message["attachments"]>): string | null {
  if (images.length === 1) return "[Image attachment]";
  return images.length > 1 ? pluralAttachmentLabel(images.length, "image") : null;
}

function fileAttachmentPreview(files: NonNullable<Message["attachments"]>): string | null {
  if (files.length === 1) return files[0]?.name ?? "[File attachment]";
  return files.length > 1 ? pluralAttachmentLabel(files.length, "file") : null;
}

function resolveAttachmentPreview(attachments: NonNullable<Message["attachments"]>): string | null {
  const images = attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const files = attachments.filter((attachment) => !attachment.mimeType.startsWith("image/"));
  if (images.length > 0 && files.length > 0) {
    return `${pluralAttachmentLabel(images.length, "image")}, ${pluralAttachmentLabel(files.length, "file")}`;
  }
  return imageAttachmentPreview(images) ?? fileAttachmentPreview(files);
}

/**
 * Resolves plain-text preview copy for the sticky last-user-message chip.
 * Returns null when the message renders nothing user-visible in the transcript.
 */
export function resolveUserMessagePreview(message: Message): string | null {
  const textContent = stripInjectedFiles(message.content);
  const attachments = message.attachments ?? [];
  const hasAttachments = attachments.length > 0;

  if (
    !hasAttachments
    && textContent.startsWith(PLAN_ANSWER_MESSAGE_PREFIX)
  ) {
    return null;
  }

  const userGoal = parseUserGoalCommand(textContent);
  if (userGoal) {
    return userGoal.condition;
  }

  const trimmed = textContent.trim();
  if (trimmed) {
    return toPlainPreview(trimmed);
  }

  if (!hasAttachments) return null;

  return resolveAttachmentPreview(attachments);
}
