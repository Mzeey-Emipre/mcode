const ATTACHMENT_MIME_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
};

/** Return the MIME type for a persisted attachment extension. */
export function getAttachmentMimeType(extension: string): string {
  return ATTACHMENT_MIME_TYPES[extension] ?? "application/octet-stream";
}
