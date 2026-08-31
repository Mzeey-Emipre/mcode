import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import {
  getAttachmentMaxSizeForMime,
  storedAttachmentSuffix,
} from "@mcode/contracts";

/** Dependencies used by the temporary attachment store. */
export interface TempAttachmentStoreDependencies {
  /** Return Electron's platform-specific temporary directory. */
  readonly getTempDirectory: () => string;
}

/** Metadata returned after a temporary attachment is written. */
export interface StagedAttachment {
  /** Cryptographically random storage identifier. */
  readonly id: string;
  /** Number of bytes written to the source path. */
  readonly sizeBytes: number;
  /** Generated path containing the staged bytes. */
  readonly sourcePath: string;
}

/** Capability for writing bounded temporary attachments. */
export interface TempAttachmentStore {
  /** Validate and write one attachment into the contained temporary directory. */
  stage(content: Uint8Array, mimeType: string): Promise<StagedAttachment>;
}

/** Directory name used below Electron's temporary directory. */
export const TEMP_ATTACHMENT_DIRECTORY_NAME = "mcode-attachments";

function resolveContainedPath(directory: string, fileName: string): string {
  const resolvedDirectory = NodePath.resolve(directory);
  const resolvedPath = NodePath.resolve(resolvedDirectory, fileName);
  const relativePath = NodePath.relative(resolvedDirectory, resolvedPath);
  if (NodePath.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new Error("Temporary attachment path escapes its directory");
  }
  return resolvedPath;
}

/** Create a temporary attachment store with generated, contained filenames. */
export function createTempAttachmentStore(
  dependencies: TempAttachmentStoreDependencies,
): TempAttachmentStore {
  const directory = NodePath.resolve(
    NodePath.join(dependencies.getTempDirectory(), TEMP_ATTACHMENT_DIRECTORY_NAME),
  );

  return {
    stage: async (content, mimeType) => {
      const maxSize = getAttachmentMaxSizeForMime(mimeType);
      if (content.byteLength > maxSize) {
        throw new Error(
          `Attachment exceeds ${maxSize} byte limit (actual: ${content.byteLength})`,
        );
      }

      await NodeFSPromises.mkdir(directory, { recursive: true });

      const id = NodeCrypto.randomUUID();
      const suffix = storedAttachmentSuffix(mimeType);
      const sourcePath = resolveContainedPath(directory, `${id}${suffix}`);
      await NodeFSPromises.writeFile(sourcePath, Buffer.from(content), { flag: "wx" });

      return {
        id,
        sizeBytes: content.byteLength,
        sourcePath,
      };
    },
  };
}
