/**
 * Attachment persistence service.
 * Handles copying, validating, and storing file attachments for threads.
 * Extracted from the attachment handling in apps/desktop/src/main/app-state.ts.
 */

import { injectable } from "tsyringe";
import { existsSync, statSync, rmSync } from "fs";
import { copyFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { getMcodeDir } from "@mcode/shared";
import type { AttachmentMeta, StoredAttachment } from "@mcode/contracts";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 32 * 1024 * 1024;
const MAX_TEXT_SIZE = 1 * 1024 * 1024;

function getMaxSizeForMime(mimeType: string): number {
  if (mimeType.startsWith("image/")) return MAX_IMAGE_SIZE;
  if (mimeType === "application/pdf") return MAX_PDF_SIZE;
  if (mimeType === "text/plain") return MAX_TEXT_SIZE;
  return MAX_IMAGE_SIZE; // conservative fallback
}

function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[mimeType] ?? "";
}

/** Resolve the base directory for attachment storage. */
function getAttachmentsDir(): string {
  return join(getMcodeDir(), "attachments");
}

/** Persists and reads file attachments for agent threads. */
@injectable()
export class AttachmentService {
  /**
   * Copy and validate attachments for a thread.
   * Returns both stored metadata (for DB) and persisted metadata (with new paths).
   */
  async persist(
    threadId: string,
    attachments: AttachmentMeta[],
  ): Promise<{
    stored: StoredAttachment[];
    persisted: AttachmentMeta[];
  }> {
    if (attachments.length === 0) return { stored: [], persisted: [] };

    const baseDir = join(getAttachmentsDir(), threadId);
    await mkdir(baseDir, { recursive: true });

    const results = await Promise.all(
      attachments.map(async (att) => {
        if (!existsSync(att.sourcePath)) {
          throw new Error(`Attachment file not found: ${att.sourcePath}`);
        }

        const actualSize = statSync(att.sourcePath).size;
        const maxSize = getMaxSizeForMime(att.mimeType);
        if (actualSize > maxSize) {
          throw new Error(
            `Attachment "${att.name}" exceeds ${maxSize} byte limit (actual: ${actualSize})`,
          );
        }

        const ext = mimeToExt(att.mimeType);
        const destPath = join(baseDir, `${att.id}${ext}`);

        await copyFile(att.sourcePath, destPath);

        // Clean up temp file if it came from a known temp location
        const tempDir = join(getMcodeDir(), "temp", "attachments");
        if (att.sourcePath.startsWith(tempDir)) {
          try {
            await unlink(att.sourcePath);
          } catch {
            /* non-fatal */
          }
        }

        return {
          stored: {
            id: att.id,
            name: att.name,
            mimeType: att.mimeType,
            sizeBytes: actualSize,
          } as StoredAttachment,
          persisted: {
            ...att,
            sourcePath: destPath,
            sizeBytes: actualSize,
          } as AttachmentMeta,
        };
      }),
    );

    return {
      stored: results.map((r) => r.stored),
      persisted: results.map((r) => r.persisted),
    };
  }

  /** Remove all attachments for a thread from disk. */
  removeForThread(threadId: string): void {
    const dir = join(getAttachmentsDir(), threadId);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }
  }
}
