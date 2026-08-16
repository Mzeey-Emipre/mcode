import { app, clipboard, ipcMain, protocol } from "electron";
import { join } from "node:path";
import { getMcodeDir } from "@mcode/shared";
import type { ClipboardIpc, ClipboardReader, ClipboardHandlers } from "./clipboard/handlers.js";
import { registerClipboardHandlers } from "./clipboard/handlers.js";
import type { AttachmentProtocolRegistry } from "./protocol/handler.js";
import { registerAttachmentProtocol } from "./protocol/handler.js";
import {
  createTempAttachmentStore,
  type TempAttachmentStore,
} from "./staging/temp-store.js";

/** Dependencies supplied by the desktop composition root for Attachments. */
export interface AttachmentsFeatureDependencies {
  /** IPC registry used to expose clipboard channels. */
  readonly ipc?: ClipboardIpc;
  /** Native clipboard implementation. */
  readonly clipboard?: ClipboardReader;
  /** Optional store seam for focused behavior tests. */
  readonly tempStore?: TempAttachmentStore;
  /** Return Electron's platform-specific temporary directory. */
  readonly getTempDirectory?: () => string;
  /** Clock used by clipboard image metadata. */
  readonly now?: () => number;
  /** Protocol registry used to serve durable attachments. */
  readonly protocol?: AttachmentProtocolRegistry;
  /** Root directory that contains durable thread attachment directories. */
  readonly attachmentsDirectory?: string;
}

/** Register the desktop Attachments feature's clipboard and durable protocol capabilities. */
export function registerAttachmentsFeature(
  dependencies: AttachmentsFeatureDependencies = {},
): ClipboardHandlers {
  const tempStore =
    dependencies.tempStore ??
    createTempAttachmentStore({
      getTempDirectory: dependencies.getTempDirectory ?? (() => app.getPath("temp")),
    });
  const clipboardHandlers = registerClipboardHandlers({
    ipc: dependencies.ipc ?? ipcMain,
    clipboard: dependencies.clipboard ?? clipboard,
    tempStore,
    now: dependencies.now ?? Date.now,
  });
  registerAttachmentProtocol({
    protocol: dependencies.protocol ?? protocol,
    attachmentsDirectory:
      dependencies.attachmentsDirectory ?? join(getMcodeDir(), "attachments"),
  });
  return clipboardHandlers;
}

export {
  createClipboardHandlers,
  registerClipboardHandlers,
  READ_CLIPBOARD_IMAGE_CHANNEL,
  SAVE_CLIPBOARD_FILE_CHANNEL,
  CLIPBOARD_MIME_TYPE_MAX_LENGTH,
  CLIPBOARD_FILE_NAME_MAX_LENGTH,
} from "./clipboard/handlers.js";
export type {
  ClipboardHandlers,
  ClipboardHandlerDependencies,
  ClipboardIpc,
  ClipboardImage,
  ClipboardReader,
} from "./clipboard/handlers.js";
export {
  createTempAttachmentStore,
  TEMP_ATTACHMENT_DIRECTORY_NAME,
} from "./staging/temp-store.js";
export type {
  StagedAttachment,
  TempAttachmentStore,
  TempAttachmentStoreDependencies,
} from "./staging/temp-store.js";
export {
  ATTACHMENT_PROTOCOL_SCHEME,
  createAttachmentProtocolHandler,
  registerAttachmentProtocol,
} from "./protocol/handler.js";
export type {
  AttachmentProtocolHandlerDependencies,
  AttachmentProtocolRegistry,
  AttachmentProtocolRequest,
} from "./protocol/handler.js";
export { getAttachmentMimeType } from "./protocol/mime-types.js";
