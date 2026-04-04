/**
 * Attachment persistence service.
 * Handles copying, validating, and storing file attachments for threads.
 * Extracted from the attachment handling in apps/desktop/src/main/app-state.ts.
 */

import { injectable } from "tsyringe";
import { existsSync, statSync, rmSync } from "fs";
import { copyFile, mkdir, unlink } from "fs/promises";
import { join, resolve, relative } from "path";
import { getMcodeDir } from "@mcode/shared";
import type { AttachmentMeta, StoredAttachment } from "@mcode/contracts";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 32 * 1024 * 1024;
const MAX_TEXT_SIZE = 1 * 1024 * 1024;

/**
 * Pattern matching safe attachment IDs: alphanumerics, hyphens, and underscores only.
 * Prevents path traversal via crafted IDs containing `../` or other special characters.
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Size limits per MIME category. Shared with binary upload handler. */
export function getMaxSizeForMime(mimeType: string): number {
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

        // Validate attachment ID to prevent path traversal
        if (!SAFE_ID_PATTERN.test(att.id)) {
          throw new Error(
            `Invalid attachment ID: ${att.id}. Only alphanumerics, hyphens, and underscores are allowed.`,
          );
        }

        const ext = mimeToExt(att.mimeType);
        const destPath = resolve(baseDir, `${att.id}${ext}`);

        // Verify destination stays within the thread attachment directory
        const rel = relative(baseDir, destPath);
        if (rel.startsWith("..") || resolve(baseDir, rel) !== destPath) {
          throw new Error(`Attachment path escapes thread directory: ${att.id}`);
        }

        await copyFile(att.sourcePath, destPath);

        // Clean up temp file if it came from a known temp location
        const tempDir = resolve(getMcodeDir(), "temp", "attachments");
        const resolvedSource = resolve(att.sourcePath);
        const tempRel = relative(tempDir, resolvedSource);
        if (!tempRel.startsWith("..") && !resolve(tempDir, tempRel).includes("..")) {
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
    // Validate threadId to prevent path traversal via crafted IDs like "../"
    if (!SAFE_ID_PATTERN.test(threadId)) {
      throw new Error(
        `Invalid thread ID: ${threadId}. Only alphanumerics, hyphens, and underscores are allowed.`,
      );
    }

    const attachmentsBase = getAttachmentsDir();
    const dir = resolve(attachmentsBase, threadId);

    // Verify the resolved path stays within the attachments directory
    const rel = relative(attachmentsBase, dir);
    if (rel.startsWith("..") || resolve(attachmentsBase, rel) !== dir) {
      throw new Error(`Thread attachment path escapes attachments directory: ${threadId}`);
    }

    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }
  }
}
