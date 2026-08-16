import type { AttachmentMeta } from "@mcode/contracts";
import type { TempAttachmentStore } from "../staging/temp-store.js";

/** IPC channel for reading a clipboard image into temporary storage. */
export const READ_CLIPBOARD_IMAGE_CHANNEL = "read-clipboard-image";

/** IPC channel for saving a clipboard file blob into temporary storage. */
export const SAVE_CLIPBOARD_FILE_CHANNEL = "save-clipboard-file";

/** Maximum accepted MIME type length at the clipboard IPC boundary. */
export const CLIPBOARD_MIME_TYPE_MAX_LENGTH = 256;

/** Maximum accepted renderer-supplied filename length at the clipboard IPC boundary. */
export const CLIPBOARD_FILE_NAME_MAX_LENGTH = 255;

/** Narrow clipboard image capability required by the attachment handlers. */
export interface ClipboardImage {
  /** Return whether the clipboard contains no image pixels. */
  isEmpty(): boolean;
  /** Convert the image to JPEG bytes at the requested quality. */
  toJPEG(quality: number): Uint8Array;
}

/** Narrow clipboard capability required by the attachment handlers. */
export interface ClipboardReader {
  /** Read the current native clipboard image. */
  readImage(): ClipboardImage;
}

/** Narrow IPC registration capability required by the attachment handlers. */
export interface ClipboardIpc {
  /** Register an invoke handler for one clipboard channel. */
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** Dependencies used to interpret clipboard input and stage its bytes. */
export interface ClipboardHandlerDependencies {
  /** Electron clipboard implementation. */
  readonly clipboard: ClipboardReader;
  /** IPC registry used to expose the clipboard channels. */
  readonly ipc: ClipboardIpc;
  /** Temporary attachment destination. */
  readonly tempStore: TempAttachmentStore;
  /** Clock used to preserve the existing clipboard image name format. */
  readonly now: () => number;
}

/** Clipboard callbacks returned for direct behavior tests and IPC registration. */
export interface ClipboardHandlers {
  /** Read, convert, and stage the current clipboard image, or return null when empty. */
  readClipboardImage(): Promise<AttachmentMeta | null>;
  /** Validate, stage, and describe a renderer-supplied clipboard file. */
  saveClipboardFile(
    buffer: unknown,
    mimeType: unknown,
    fileName: unknown,
  ): Promise<AttachmentMeta>;
}

function validateMimeType(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Clipboard MIME type must be a string");
  }
  if (
    value.trim().length === 0 ||
    value.length > CLIPBOARD_MIME_TYPE_MAX_LENGTH ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Clipboard MIME type must be non-empty and bounded");
  }
  return value;
}

function validateFileName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Clipboard filename must be a string");
  }
  if (
    value.trim().length === 0 ||
    value.length > CLIPBOARD_FILE_NAME_MAX_LENGTH ||
    value === "." ||
    value === ".." ||
    /[\\/\0]/.test(value)
  ) {
    throw new Error("Clipboard filename must be a non-empty basename");
  }
  return value;
}

function validateBinary(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("Clipboard file data must be a Uint8Array");
  }
  return value;
}

/** Create clipboard callbacks with explicit native and staging dependencies. */
export function createClipboardHandlers(
  dependencies: Omit<ClipboardHandlerDependencies, "ipc">,
): ClipboardHandlers {
  return {
    readClipboardImage: async () => {
      const image = dependencies.clipboard.readImage();
      if (image.isEmpty()) return null;

      const mimeType = "image/jpeg";
      const content = image.toJPEG(85);
      const staged = await dependencies.tempStore.stage(content, mimeType);
      return {
        id: staged.id,
        name: `clipboard-${dependencies.now()}.jpg`,
        mimeType,
        sizeBytes: staged.sizeBytes,
        sourcePath: staged.sourcePath,
      };
    },
    saveClipboardFile: async (buffer, mimeType, fileName) => {
      const content = validateBinary(buffer);
      const validatedMimeType = validateMimeType(mimeType);
      const validatedFileName = validateFileName(fileName);
      const staged = await dependencies.tempStore.stage(content, validatedMimeType);
      return {
        id: staged.id,
        name: validatedFileName,
        mimeType: validatedMimeType,
        sizeBytes: staged.sizeBytes,
        sourcePath: staged.sourcePath,
      };
    },
  };
}

/** Register the clipboard attachment IPC handlers with the supplied dependencies. */
export function registerClipboardHandlers(
  dependencies: ClipboardHandlerDependencies,
): ClipboardHandlers {
  const handlers = createClipboardHandlers(dependencies);
  dependencies.ipc.handle(READ_CLIPBOARD_IMAGE_CHANNEL, () => handlers.readClipboardImage());
  dependencies.ipc.handle(
    SAVE_CLIPBOARD_FILE_CHANNEL,
    (_event, buffer, mimeType, fileName) =>
      handlers.saveClipboardFile(buffer, mimeType, fileName),
  );
  return handlers;
}
