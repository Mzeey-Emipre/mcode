import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_DOCUMENT_MAX_BYTES,
  ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES,
  ATTACHMENT_PDF_MAX_BYTES,
  ATTACHMENT_TEXT_MAX_BYTES,
  getAttachmentMaxSizeForMime,
} from "@mcode/contracts";
import {
  createTempAttachmentStore,
  TEMP_ATTACHMENT_DIRECTORY_NAME,
} from "../temp-store.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-attachment-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => NodeFSPromises.rm(directory, { recursive: true, force: true })));
});

describe("temporary attachment store", () => {
  it("creates contained generated paths and preserves exact bytes", async () => {
    const root = await createTemporaryDirectory();
    const store = createTempAttachmentStore({ getTempDirectory: () => root });
    const content = Uint8Array.from([0, 1, 2, 255]);

    const staged = await store.stage(content, "text/plain");

    expect(staged.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(staged.sizeBytes).toBe(content.byteLength);
    expect(await NodeFSPromises.readFile(staged.sourcePath)).toEqual(Buffer.from(content));
    expect(NodePath.dirname(staged.sourcePath)).toBe(NodePath.join(root, TEMP_ATTACHMENT_DIRECTORY_NAME));
    expect(NodePath.relative(NodePath.join(root, TEMP_ATTACHMENT_DIRECTORY_NAME), staged.sourcePath)).not.toMatch(
      /^(\.\.|[\\/])/,
    );
    expect(NodePath.basename(staged.sourcePath)).toMatch(/^[0-9a-f-]{36}\.txt$/);
  });

  it("uses a new cryptographic storage identity for each staged file", async () => {
    const root = await createTemporaryDirectory();
    const store = createTempAttachmentStore({ getTempDirectory: () => root });

    const first = await store.stage(Uint8Array.from([1]), "application/octet-stream");
    const second = await store.stage(Uint8Array.from([2]), "application/octet-stream");

    expect(first.id).not.toBe(second.id);
    expect(await NodeFSPromises.readdir(NodePath.join(root, TEMP_ATTACHMENT_DIRECTORY_NAME))).toHaveLength(2);
  });

  it.each([
    ["image/png", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
    ["application/pdf", ATTACHMENT_PDF_MAX_BYTES],
    ["text/plain", ATTACHMENT_TEXT_MAX_BYTES],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", 16 * 1024 * 1024],
    ["application/octet-stream", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
  ])("rejects bytes above the %s policy before creating the directory", async (mimeType, limit) => {
    const root = await createTemporaryDirectory();
    const store = createTempAttachmentStore({ getTempDirectory: () => root });

    await expect(store.stage(new Uint8Array(limit + 1), mimeType)).rejects.toThrow(
      `${getAttachmentMaxSizeForMime(mimeType)} byte limit`,
    );
    await expect(NodeFSPromises.readdir(NodePath.join(root, TEMP_ATTACHMENT_DIRECTORY_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["image/png", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
    ["application/pdf", ATTACHMENT_PDF_MAX_BYTES],
    ["text/plain", ATTACHMENT_TEXT_MAX_BYTES],
    ["application/rtf", ATTACHMENT_DOCUMENT_MAX_BYTES],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ATTACHMENT_DOCUMENT_MAX_BYTES],
    ["application/vnd.oasis.opendocument.text", ATTACHMENT_DOCUMENT_MAX_BYTES],
    ["application/octet-stream", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
  ])("accepts a payload exactly at the %s policy limit", async (mimeType, limit) => {
    const root = await createTemporaryDirectory();
    const store = createTempAttachmentStore({ getTempDirectory: () => root });
    const content = new Uint8Array(limit);

    const staged = await store.stage(content, mimeType);

    expect(staged.sizeBytes).toBe(limit);
    expect((await NodeFSPromises.readFile(staged.sourcePath)).byteLength).toBe(limit);
  });

  it.each([
    ["image/png", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
    ["application/pdf", ATTACHMENT_PDF_MAX_BYTES],
    ["text/plain", ATTACHMENT_TEXT_MAX_BYTES],
    ["application/rtf", ATTACHMENT_DOCUMENT_MAX_BYTES],
    ["application/octet-stream", ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES],
  ])("accepts bytes immediately below the %s policy limit", async (mimeType, limit) => {
    const root = await createTemporaryDirectory();
    const store = createTempAttachmentStore({ getTempDirectory: () => root });

    const staged = await store.stage(new Uint8Array(limit - 1), mimeType);

    expect(staged.sizeBytes).toBe(limit - 1);
    expect((await NodeFSPromises.readFile(staged.sourcePath)).byteLength).toBe(limit - 1);
  });

  it("surfaces directory and write failures without manufacturing metadata", async () => {
    const root = await createTemporaryDirectory();
    await NodeFSPromises.writeFile(NodePath.join(root, TEMP_ATTACHMENT_DIRECTORY_NAME), "not a directory");
    const store = createTempAttachmentStore({ getTempDirectory: () => root });

    await expect(store.stage(Uint8Array.from([1, 2, 3]), "text/plain")).rejects.toThrow();
    expect(await NodeFSPromises.readFile(NodePath.join(root, TEMP_ATTACHMENT_DIRECTORY_NAME), "utf8")).toBe(
      "not a directory",
    );
  });
});
