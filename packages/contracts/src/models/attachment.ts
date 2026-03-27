import { z } from "zod";

/** Metadata for an image or file attachment. No binary data, just a pointer. */
export const AttachmentMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  sourcePath: z.string(),
});
/** Metadata for an image or file attachment including its source path. */
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/** Stored attachment metadata (no sourcePath, since files live at a known location). */
export const StoredAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
/** Stored attachment metadata without a source path. */
export type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;
