import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExtension, type WsMethodName, WS_METHODS } from "@mcode/contracts";
import type { z } from "zod";

type AttachmentRpcMethod = "clipboard.saveFile";

type AttachmentRpcParamsByMethod = {
  [Method in AttachmentRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

type AttachmentHandlerMap = {
  [Method in AttachmentRpcMethod]: (
    params: AttachmentRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const attachmentHandlers: AttachmentHandlerMap = {
  // JSON-RPC remains available for clients that cannot upload a binary frame.
  "clipboard.saveFile": saveClipboardFile,
};

/** Checks whether a method belongs to the attachment RPC family. */
export function isAttachmentRpcMethod(method: WsMethodName): method is AttachmentRpcMethod {
  return Object.hasOwn(attachmentHandlers, method);
}

/** Routes validated attachment RPC parameters to temporary attachment storage. */
export async function routeAttachmentRpc<Method extends AttachmentRpcMethod>(
  method: Method,
  params: AttachmentRpcParamsByMethod[Method],
): Promise<unknown> {
  return await attachmentHandlers[method](params);
}

async function saveClipboardFile(
  params: AttachmentRpcParamsByMethod["clipboard.saveFile"],
): Promise<unknown> {
  if (!params.data) {
    throw new Error("clipboard.saveFile via JSON-RPC requires the data field; use binary upload instead");
  }
  const buffer = Buffer.from(params.data, "base64");
  const id = randomUUID();
  const extension = getExtension(params.fileName);
  const suffix = extension ? `.${extension}` : "";
  const tempDir = join(tmpdir(), "mcode-attachments");
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${id}${suffix}`);
  await writeFile(tempPath, buffer);
  return {
    id,
    name: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: buffer.byteLength,
    sourcePath: tempPath,
  };
}
