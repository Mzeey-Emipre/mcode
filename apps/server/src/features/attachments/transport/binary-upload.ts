/**
 * Binary WebSocket upload handler.
 * Receives raw binary payloads and writes them to temp files,
 * returning attachment metadata identical to the JSON-RPC path.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { getAttachmentMaxSizeForMime } from "@mcode/contracts";
import { getMcodeDir } from "@mcode/shared";

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
  const safeName = NodePath.basename(meta.fileName);

  // Enforce size limits (shared with AttachmentService)
  const maxSize = getAttachmentMaxSizeForMime(meta.mimeType);
  if (payload.byteLength > maxSize) {
    throw new Error(
      `File "${meta.fileName}" exceeds ${maxSize} byte limit (actual: ${payload.byteLength})`,
    );
  }

  const id = NodeCrypto.randomUUID();
  const tempDir = NodePath.join(getMcodeDir(), "temp", "attachments");
  await NodeFSPromises.mkdir(tempDir, { recursive: true });
  // Prefix with UUID to guarantee uniqueness; retain original name for debuggability.
  const tempPath = NodePath.join(tempDir, `${id}-${safeName}`);
  await NodeFSPromises.writeFile(tempPath, payload);

  return {
    id,
    name: meta.fileName,
    mimeType: meta.mimeType,
    sizeBytes: payload.byteLength,
    sourcePath: tempPath,
  };
}
