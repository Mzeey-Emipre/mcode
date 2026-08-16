/** Maximum bytes accepted for image and unknown attachment MIME types. */
export const ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES = 5 * 1024 * 1024;

/** Maximum bytes accepted for PDF attachments. */
export const ATTACHMENT_PDF_MAX_BYTES = 32 * 1024 * 1024;

/** Maximum bytes accepted for plain-text attachments. */
export const ATTACHMENT_TEXT_MAX_BYTES = 1 * 1024 * 1024;

/** Maximum bytes accepted for supported document attachments. */
export const ATTACHMENT_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Return the canonical attachment byte limit for a MIME type.
 *
 * Unknown MIME types use the conservative image limit. Matching intentionally
 * preserves the server persistence policy's existing MIME categories.
 */
export function getAttachmentMaxSizeForMime(mimeType: string): number {
  if (mimeType.startsWith("image/")) return ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES;
  if (mimeType === "application/pdf") return ATTACHMENT_PDF_MAX_BYTES;
  if (mimeType === "text/plain") return ATTACHMENT_TEXT_MAX_BYTES;
  if (
    mimeType === "application/rtf" ||
    mimeType === "text/rtf" ||
    mimeType.startsWith("application/vnd.openxmlformats-officedocument.") ||
    mimeType.startsWith("application/vnd.oasis.opendocument.")
  ) {
    return ATTACHMENT_DOCUMENT_MAX_BYTES;
  }
  return ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES;
}
