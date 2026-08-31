import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_PROTOCOL_SCHEME,
  registerAttachmentProtocol,
  type AttachmentProtocolRequest,
} from "../handler.js";

const THREAD_ID = "01234567-89ab-cdef-0123-456789abcdef";
const ATTACHMENT_ID = "abcdef01-2345-6789-abcd-ef0123456789";
const temporaryDirectories: string[] = [];

type ProtocolHandler = (request: AttachmentProtocolRequest) => Response | Promise<Response>;

async function createProtocolHandler(): Promise<{
  root: string;
  threadDirectory: string;
  handler: ProtocolHandler;
}> {
  const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-attachment-protocol-"));
  temporaryDirectories.push(root);
  const threadDirectory = NodePath.join(root, THREAD_ID);
  await NodeFSPromises.mkdir(threadDirectory, { recursive: true });

  let handler: ProtocolHandler | undefined;
  registerAttachmentProtocol({
    attachmentsDirectory: root,
    protocol: {
      handle: (scheme, callback) => {
        expect(scheme).toBe(ATTACHMENT_PROTOCOL_SCHEME);
        handler = callback;
      },
    },
  });
  if (!handler) throw new Error("Attachment protocol was not registered");
  return { root, threadDirectory, handler };
}

async function request(handler: ProtocolHandler, url: string): Promise<Response> {
  return handler({ url });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => NodeFSPromises.rm(directory, { recursive: true, force: true })));
});

describe("durable attachment protocol", () => {
  it("streams exact bytes and preserves headers for every supported MIME mapping", async () => {
    const { threadDirectory, handler } = await createProtocolHandler();
    const mappings = [
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
      ["png", "image/png"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
      ["pdf", "application/pdf"],
      ["txt", "text/plain"],
    ] as const;
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);

    for (const [extension, mimeType] of mappings) {
      await NodeFSPromises.writeFile(NodePath.join(threadDirectory, `${ATTACHMENT_ID}.${extension}`), bytes);
      const response = await request(
        handler,
        `mcode-attachment://${THREAD_ID}/${ATTACHMENT_ID}.${extension}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(ReadableStream);
      expect(response.headers.get("Content-Type")).toBe(mimeType);
      expect(response.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
  });

  it("uses the existing binary fallback for unknown extensions", async () => {
    const { threadDirectory, handler } = await createProtocolHandler();
    const bytes = Uint8Array.from([9, 8, 7]);
    await NodeFSPromises.writeFile(NodePath.join(threadDirectory, `${ATTACHMENT_ID}.bin`), bytes);

    const response = await request(
      handler,
      `mcode-attachment://${THREAD_ID}/${ATTACHMENT_ID}.bin`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("ignores cache-busting queries while serving the contained attachment", async () => {
    const { threadDirectory, handler } = await createProtocolHandler();
    const bytes = Uint8Array.from([3, 1, 4, 1, 5]);
    await NodeFSPromises.writeFile(NodePath.join(threadDirectory, `${ATTACHMENT_ID}.jpg`), bytes);

    const response = await request(
      handler,
      `mcode-attachment://${THREAD_ID}/${ATTACHMENT_ID}.jpg?mcodeRetry=1`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("returns 400 for malformed URLs and invalid identifiers before file access", async () => {
    const { handler } = await createProtocolHandler();
    const invalidUrls = [
      `mcode-attachment://${THREAD_ID}/%E0%A4%A.txt`,
      `mcode-attachment://not_valid/${ATTACHMENT_ID}.txt`,
      `mcode-attachment://${THREAD_ID}/zzzz.txt`,
      `mcode-attachment://${THREAD_ID}/${ATTACHMENT_ID}%2Fnested.txt`,
      `mcode-attachment://${THREAD_ID}/${ATTACHMENT_ID}.txt/child`,
      `mcode-attachment://${THREAD_ID}/%2e%2e%2f${ATTACHMENT_ID}.txt`,
      `mcode-attachment://%2e%2e/${ATTACHMENT_ID}.txt`,
      `mcode-attachment://user@${THREAD_ID}/${ATTACHMENT_ID}.txt`,
      `mcode-attachment://${THREAD_ID}:80/${ATTACHMENT_ID}.txt`,
    ];

    for (const url of invalidUrls) {
      const response = await request(handler, url);
      expect(response.status, url).toBe(400);
    }
  });

  it("returns 404 for missing files and directory targets", async () => {
    const { threadDirectory, handler } = await createProtocolHandler();
    const directoryTarget = NodePath.join(threadDirectory, `${ATTACHMENT_ID}.txt`);
    await NodeFSPromises.mkdir(directoryTarget);

    const missingResponse = await request(
      handler,
      `mcode-attachment://${THREAD_ID}/abcdef01-2345-6789-abcd-ef01234567aa.txt`,
    );
    const directoryResponse = await request(
      handler,
      `mcode-attachment://${THREAD_ID}/${ATTACHMENT_ID}.txt`,
    );

    expect(missingResponse.status).toBe(404);
    expect(directoryResponse.status).toBe(404);
  });

  it("returns 404 when a thread directory resolves outside the attachment root", async () => {
    const { root, handler } = await createProtocolHandler();
    const outsideRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-attachment-outside-"));
    temporaryDirectories.push(outsideRoot);
    const outsideThread = NodePath.join(outsideRoot, THREAD_ID);
    await NodeFSPromises.mkdir(outsideThread, { recursive: true });
    await NodeFSPromises.writeFile(NodePath.join(outsideThread, `${ATTACHMENT_ID}.txt`), "outside");
    await NodeFSPromises.rm(NodePath.join(root, THREAD_ID), { recursive: true, force: true });
    await NodeFSPromises.symlink(outsideThread, NodePath.join(root, THREAD_ID), "junction");

    const response = await request(
      handler,
      `mcode-attachment://${THREAD_ID}/${ATTACHMENT_ID}.txt`,
    );

    expect(response.status).toBe(404);
  });
});
