/**
 * Binary WebSocket upload handler.
 * Receives raw binary payloads and writes them to temp files,
 * returning attachment metadata identical to the JSON-RPC path.
 */

import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join, basename } from "path";
import { getMcodeDir } from "@mcode/shared";
import { getMaxSizeForMime } from "../services/attachment-service";

/** Metadata accompanying a binary upload frame. */
interface BinaryUploadMeta {
  mimeType: string;
  fileName: string;
}

/** Result returned after a successful binary upload. */
interface BinaryUploadResult {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string;
}

/**
 * Handle a binary attachment upload.
 * Validates the payload size and filename, writes to a temp file, and returns metadata.
 */
export async function handleBinaryUpload(
  meta: BinaryUploadMeta,
  payload: Buffer,
): Promise<BinaryUploadResult> {
  // Validate fileName has no path separators
  if (/[/\\\0]/.test(meta.fileName)) {
    throw new Error("fileName must not contain path separators or null bytes");
  }
  // Normalize to basename to strip any directory components (e.g., Windows drive-relative paths)
  const safeName = basename(meta.fileName);

  // Enforce size limits (shared with AttachmentService)
  const maxSize = getMaxSizeForMime(meta.mimeType);
  if (payload.byteLength > maxSize) {
    throw new Error(
      `File "${meta.fileName}" exceeds ${maxSize} byte limit (actual: ${payload.byteLength})`,
    );
  }

  const id = randomUUID();
  const tempDir = join(getMcodeDir(), "temp", "attachments");
  await mkdir(tempDir, { recursive: true });
  // Prefix with UUID to guarantee uniqueness; retain original name for debuggability.
  const tempPath = join(tempDir, `${id}-${safeName}`);
  await writeFile(tempPath, payload);

  return {
    id,
    name: meta.fileName,
    mimeType: meta.mimeType,
    sizeBytes: payload.byteLength,
    sourcePath: tempPath,
  };
}
