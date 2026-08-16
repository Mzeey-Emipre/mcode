import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DOCUMENT_MAX_BYTES,
  ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES,
  ATTACHMENT_PDF_MAX_BYTES,
  ATTACHMENT_TEXT_MAX_BYTES,
  getAttachmentMaxSizeForMime,
} from "../index.js";

describe("attachment MIME size policy", () => {
  it.each([
    ["image/png", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
    ["application/pdf", ATTACHMENT_PDF_MAX_BYTES],
    ["text/plain", ATTACHMENT_TEXT_MAX_BYTES],
    ["application/rtf", ATTACHMENT_DOCUMENT_MAX_BYTES],
    ["text/rtf", ATTACHMENT_DOCUMENT_MAX_BYTES],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ATTACHMENT_DOCUMENT_MAX_BYTES,
    ],
    ["application/vnd.oasis.opendocument.text", ATTACHMENT_DOCUMENT_MAX_BYTES],
    ["application/octet-stream", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
  ])("returns the existing limit for %s", (mimeType, expected) => {
    expect(getAttachmentMaxSizeForMime(mimeType)).toBe(expected);
  });
});
