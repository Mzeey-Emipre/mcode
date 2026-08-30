import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { getAttachmentMimeType } from "./mime-types.js";

/** Scheme used to render durable attachment files in the desktop renderer. */
export const ATTACHMENT_PROTOCOL_SCHEME = "mcode-attachment";

const VALID_THREAD_ID = /^[a-f0-9-]+$/;
const VALID_ATTACHMENT_FILE = /^([a-f0-9-]+)\.(\w+)$/;

/** Request shape consumed by the durable attachment protocol handler. */
export interface AttachmentProtocolRequest {
  /** URL supplied by the protocol request. */
  readonly url: string;
}

/** Protocol registry capability used to install the attachment handler. */
export interface AttachmentProtocolRegistry {
  /** Register a callback for one custom protocol scheme. */
  handle(
    scheme: string,
    handler: (request: AttachmentProtocolRequest) => Response | Promise<Response>,
  ): void;
}

/** Dependencies required to register and resolve durable attachment files. */
export interface AttachmentProtocolHandlerDependencies {
  /** Registry that owns the custom protocol callback. */
  readonly protocol: AttachmentProtocolRegistry;
  /** Root directory that contains one durable directory per thread. */
  readonly attachmentsDirectory: string;
}

interface ParsedAttachmentUrl {
  readonly threadId: string;
  readonly fileName: string;
  readonly extension: string;
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath.length > 0 && !isAbsolute(relativePath) && !relativePath.startsWith("..");
}

function parseAttachmentUrl(requestUrl: unknown): ParsedAttachmentUrl | null {
  if (typeof requestUrl !== "string") return null;
  try {
    return parseAttachmentUrlParts(new URL(requestUrl));
  } catch {
    return null;
  }
}

function parseAttachmentUrlParts(url: URL): ParsedAttachmentUrl | null {
  if (!isAttachmentProtocolUrl(url)) return null;
  const threadId = decodeURIComponent(url.hostname);
  const pathName = decodeURIComponent(url.pathname);
  if (!pathName.startsWith("/") || pathName.length < 2) return null;
  return parseAttachmentFileName(threadId, pathName.slice(1));
}

function isAttachmentProtocolUrl(url: URL): boolean {
  return (
    url.protocol === `${ATTACHMENT_PROTOCOL_SCHEME}:` &&
    !url.username &&
    !url.password &&
    !url.port
  );
}

function parseAttachmentFileName(threadId: string, fileName: string): ParsedAttachmentUrl | null {
  const match = VALID_ATTACHMENT_FILE.exec(fileName);
  if (!match || fileName.includes("/") || fileName.includes("\\")) return null;
  if (!VALID_THREAD_ID.test(threadId)) return null;
  return { threadId, fileName, extension: match[2] };
}

async function resolveAttachmentFile(
  attachmentsDirectory: string,
  parsed: ParsedAttachmentUrl,
): Promise<string | null> {
  const rootDirectory = resolve(attachmentsDirectory);
  const threadDirectory = resolve(rootDirectory, parsed.threadId);
  const candidatePath = resolve(threadDirectory, parsed.fileName);
  if (
    !isContainedPath(rootDirectory, threadDirectory) ||
    !isContainedPath(threadDirectory, candidatePath)
  ) {
    return null;
  }

  try {
    const [realRootDirectory, realThreadDirectory, realCandidatePath] = await Promise.all([
      realpath(rootDirectory),
      realpath(threadDirectory),
      realpath(candidatePath),
    ]);
    if (
      !isContainedPath(realRootDirectory, realThreadDirectory) ||
      !isContainedPath(realThreadDirectory, realCandidatePath)
    ) {
      return null;
    }

    const fileStat = await stat(realCandidatePath);
    return fileStat.isFile() ? realCandidatePath : null;
  } catch {
    return null;
  }
}

/** Create the callback that serves validated durable attachment requests. */
export function createAttachmentProtocolHandler(
  dependencies: Omit<AttachmentProtocolHandlerDependencies, "protocol">,
): (request: AttachmentProtocolRequest) => Promise<Response> {
  return async (request) => {
    const parsed = parseAttachmentUrl(request.url);
    if (!parsed) return new Response("Invalid attachment URL", { status: 400 });

    const filePath = await resolveAttachmentFile(dependencies.attachmentsDirectory, parsed);
    if (!filePath) return new Response("Not found", { status: 404 });

    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(webStream, {
      headers: {
        "Content-Type": getAttachmentMimeType(parsed.extension),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  };
}

/** Register durable attachment serving on the supplied custom protocol registry. */
export function registerAttachmentProtocol(
  dependencies: AttachmentProtocolHandlerDependencies,
): void {
  dependencies.protocol.handle(
    ATTACHMENT_PROTOCOL_SCHEME,
    createAttachmentProtocolHandler(dependencies),
  );
}
