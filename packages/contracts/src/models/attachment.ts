import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * MIME marker for composer rows that carry only structured browser capture JSON in the
 * outbound fence without a persisted image file.
 */
export const MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME = "application/x-mcode-browser-context";

/** True when attachment metadata denotes a fence-only preview context row (no disk file). */
export function isVirtualBrowserContextAttachment(mimeType: string): boolean {
  return mimeType.trim() === MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME;
}

/**
 * True when this metadata row must never touch the filesystem (structured browser capture only).
 * Handles clients that omit or mis-send {@link MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME}.
 */
export function shouldPersistAttachmentWithoutFile(att: AttachmentMeta): boolean {
  if (isVirtualBrowserContextAttachment(att.mimeType)) return true;
  const pathEmpty = !att.sourcePath || att.sourcePath.trim() === "";
  return att.sizeBytes === 0 && pathEmpty && att.name === "Page context";
}

/** Metadata for an image or file attachment. No binary data, just a pointer. */
export const AttachmentMetaSchema = lazySchema(() => z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  sourcePath: z.string(),
}));
/** Metadata for an image or file attachment including its source path. */
export type AttachmentMeta = z.infer<ReturnType<typeof AttachmentMetaSchema>>;

/** Stored attachment metadata (no sourcePath, since files live at a known location). */
export const StoredAttachmentSchema = lazySchema(() => z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
}));
/** Stored attachment metadata without a source path. */
export type StoredAttachment = z.infer<ReturnType<typeof StoredAttachmentSchema>>;

/**
 * Returns the file suffix (including the leading dot) used when persisting an attachment
 * to `{mcodeDir}/attachments/{threadId}/{id}{suffix}`. Must match the server's attachment
 * persistence naming so URLs and disk paths stay aligned.
 */
export function storedAttachmentSuffix(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/rtf": ".rtf",
    "text/rtf": ".rtf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.oasis.opendocument.text": ".odt",
    "application/vnd.oasis.opendocument.spreadsheet": ".ods",
    "application/vnd.oasis.opendocument.presentation": ".odp",
  };
  return map[mimeType] ?? "";
}
