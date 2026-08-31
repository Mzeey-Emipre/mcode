import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES,
  getAttachmentMaxSizeForMime,
} from "@mcode/contracts";
import {
  CLIPBOARD_FILE_NAME_MAX_LENGTH,
  CLIPBOARD_MIME_TYPE_MAX_LENGTH,
  registerClipboardHandlers,
  type ClipboardImage,
} from "../handlers.js";
import { createTempAttachmentStore } from "../../staging/temp-store.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-clipboard-handlers-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => NodeFSPromises.rm(directory, { recursive: true, force: true })));
});

function createDependencies(root: string, image: ClipboardImage) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
  const clipboard = { readImage: vi.fn(() => image) };
  registerClipboardHandlers({
    ipc,
    clipboard,
    tempStore: createTempAttachmentStore({ getTempDirectory: () => root }),
    now: () => 1_700_000_000_000,
  });
  return { handlers, clipboard };
}

describe("clipboard attachment handlers", () => {
  it("returns null without writing when the clipboard image is empty", async () => {
    const root = await createTemporaryDirectory();
    const image: ClipboardImage = {
      isEmpty: () => true,
      toJPEG: vi.fn(() => Uint8Array.from([1])),
    };
    const { handlers } = createDependencies(root, image);

    const result = await handlers.get("read-clipboard-image")?.({});

    expect(result).toBeNull();
    expect(image.toJPEG).not.toHaveBeenCalled();
    await expect(NodeFSPromises.readdir(NodePath.join(root, "mcode-attachments"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converts non-empty images at JPEG quality 85 and returns exact metadata and bytes", async () => {
    const root = await createTemporaryDirectory();
    const image: ClipboardImage = {
      isEmpty: () => false,
      toJPEG: vi.fn((quality) => {
        expect(quality).toBe(85);
        return Uint8Array.from([9, 8, 7]);
      }),
    };
    const { handlers } = createDependencies(root, image);

    const result = (await handlers.get("read-clipboard-image")?.({})) as {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    };

    expect(result).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "clipboard-1700000000000.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 3,
    });
    expect(await NodeFSPromises.readFile(result.sourcePath)).toEqual(Buffer.from([9, 8, 7]));
  });

  it("stages valid file bytes while keeping the supplied filename as metadata only", async () => {
    const root = await createTemporaryDirectory();
    const { handlers } = createDependencies(root, {
      isEmpty: () => true,
      toJPEG: () => Uint8Array.from([]),
    });
    const payload = Uint8Array.from([4, 5, 6]);

    const result = (await handlers.get("save-clipboard-file")?.({}, payload, "text/plain", "notes.txt")) as {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    };

    expect(result).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    });
    expect(NodePath.basename(result.sourcePath)).toMatch(/^[0-9a-f-]{36}\.txt$/);
    expect(result.sourcePath).not.toContain("notes");
    expect(await NodeFSPromises.readFile(result.sourcePath)).toEqual(Buffer.from(payload));
  });

  it.each([
    [new ArrayBuffer(1), "text/plain", "notes.txt"],
    [Uint8Array.from([1]), "", "notes.txt"],
    [Uint8Array.from([1]), "x".repeat(CLIPBOARD_MIME_TYPE_MAX_LENGTH + 1), "notes.txt"],
    [Uint8Array.from([1]), "text/plain", ""],
    [Uint8Array.from([1]), "text/plain", "../notes.txt"],
    [Uint8Array.from([1]), "text/plain", "x".repeat(CLIPBOARD_FILE_NAME_MAX_LENGTH + 1)],
  ])("rejects hostile clipboard input before writing: %s", async (buffer, mimeType, fileName) => {
    const root = await createTemporaryDirectory();
    const { handlers } = createDependencies(root, {
      isEmpty: () => true,
      toJPEG: () => Uint8Array.from([]),
    });

    await expect(handlers.get("save-clipboard-file")?.({}, buffer, mimeType, fileName)).rejects.toThrow();
    await expect(NodeFSPromises.readdir(NodePath.join(root, "mcode-attachments"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized file before creating temporary storage", async () => {
    const root = await createTemporaryDirectory();
    const { handlers } = createDependencies(root, {
      isEmpty: () => true,
      toJPEG: () => Uint8Array.from([]),
    });
    const limit = getAttachmentMaxSizeForMime("application/octet-stream");

    await expect(
      handlers.get("save-clipboard-file")?.(
        {},
        new Uint8Array(limit + 1),
        "application/octet-stream",
        "payload.bin",
      ),
    ).rejects.toThrow(`${ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES} byte limit`);
    await expect(NodeFSPromises.readdir(NodePath.join(root, "mcode-attachments"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
