import * as NodeFSPromises from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { routeAttachmentRpc } from "../attachment-rpc.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => NodeFSPromises.rm(path, { force: true })));
});

describe("routeAttachmentRpc", () => {
  it("persists the JSON-RPC clipboard data as a temporary attachment", async () => {
    const result = await routeAttachmentRpc("clipboard.saveFile", {
      data: Buffer.from("clipboard text").toString("base64"),
      fileName: "clipboard.txt",
      mimeType: "text/plain",
    });
    const attachment = result as {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    };
    createdPaths.push(attachment.sourcePath);

    expect(attachment).toMatchObject({
      id: expect.any(String),
      name: "clipboard.txt",
      mimeType: "text/plain",
      sizeBytes: 14,
    });
    expect(attachment.sourcePath).toMatch(/mcode-attachments.*\.txt$/);
    await expect(NodeFSPromises.readFile(attachment.sourcePath, "utf8")).resolves.toBe("clipboard text");
  });

  it("requires data when a client uses the legacy JSON-RPC path", async () => {
    await expect(routeAttachmentRpc("clipboard.saveFile", {
      fileName: "clipboard.txt",
      mimeType: "text/plain",
    })).rejects.toThrow(
      "clipboard.saveFile via JSON-RPC requires the data field; use binary upload instead",
    );
  });
});
