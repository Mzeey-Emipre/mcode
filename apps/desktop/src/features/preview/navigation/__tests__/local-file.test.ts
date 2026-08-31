import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  looksLikeFilePath,
  resolveLocalFileUrl,
  resolveMcodeWorkspacePreviewUrl,
  validateResumeUrl,
} from "../local-file.js";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-preview-local-file-"));
  await NodeFSPromises.mkdir(NodePath.join(workspacePath, "sub"));
  await NodeFSPromises.writeFile(NodePath.join(workspacePath, "index.html"), "<h1>Home</h1>");
  await NodeFSPromises.writeFile(NodePath.join(workspacePath, "sub", "page.html"), "<h1>Page</h1>");
  await NodeFSPromises.writeFile(NodePath.join(workspacePath, ".env"), "SECRET=value");
});

afterEach(async () => {
  await NodeFSPromises.rm(workspacePath, { recursive: true, force: true });
});

describe("preview local file navigation", () => {
  it("resolves relative files and directory indexes inside the workspace", async () => {
    await expect(resolveLocalFileUrl("sub/page.html", workspacePath)).resolves.toEqual({
      ok: true,
      url: NodeURL.pathToFileURL(NodePath.join(workspacePath, "sub", "page.html")).href,
    });
    await expect(resolveLocalFileUrl(workspacePath, null)).resolves.toEqual({
      ok: true,
      url: NodeURL.pathToFileURL(NodePath.join(workspacePath, "index.html")).href,
    });
  });

  it("requires a workspace for relative paths", async () => {
    await expect(resolveLocalFileUrl("sub/page.html", null)).resolves.toEqual({
      ok: false,
      error: "no-workspace",
    });
  });

  it("rejects missing files and directories without an index", async () => {
    await expect(resolveLocalFileUrl("missing.html", workspacePath)).resolves.toEqual({
      ok: false,
      error: "file-not-found",
    });
    await expect(resolveLocalFileUrl("sub", workspacePath)).resolves.toEqual({
      ok: false,
      error: "is-directory",
    });
  });

  it("blocks sensitive paths, remote file hosts, and UNC shares", async () => {
    await expect(resolveLocalFileUrl(".env", workspacePath)).resolves.toEqual({
      ok: false,
      error: "sensitive-file",
    });
    await expect(resolveLocalFileUrl("file://attacker/share/page.html", null)).resolves.toEqual({
      ok: false,
      error: "sensitive-file",
    });
    await expect(resolveLocalFileUrl("\\\\attacker\\share\\page.html", null)).resolves.toEqual({
      ok: false,
      error: "sensitive-file",
    });
  });

  it("rechecks symlink targets before serving them", async () => {
    const sensitiveDirectory = NodePath.join(workspacePath, ".ssh");
    const linkPath = NodePath.join(workspacePath, "safe-looking.html");
    await NodeFSPromises.mkdir(sensitiveDirectory);
    await NodeFSPromises.writeFile(NodePath.join(sensitiveDirectory, "secret.html"), "secret");
    await NodeFSPromises.symlink(NodePath.join(sensitiveDirectory, "secret.html"), linkPath, "file");

    await expect(resolveLocalFileUrl(linkPath, null)).resolves.toEqual({
      ok: false,
      error: "sensitive-file",
    });
  });

  it("bounds workspace URLs to relative decoded segments", async () => {
    await expect(
      resolveMcodeWorkspacePreviewUrl("mcode-workspace:///sub/page.html", workspacePath),
    ).resolves.toEqual({
      ok: true,
      url: NodeURL.pathToFileURL(NodePath.join(workspacePath, "sub", "page.html")).href,
    });
    for (const address of [
      "mcode-workspace:///%2Ftmp%2Foutside.html",
      "mcode-workspace:///%2e%2e%2Fescape.html",
      "mcode-workspace:///bad%ZZ/page.html",
    ]) {
      await expect(resolveMcodeWorkspacePreviewUrl(address, workspacePath)).resolves.toEqual({
        ok: false,
        error: "invalid-url",
      });
    }
  });

  it("validates restored file URLs with the same security rules", async () => {
    const safeUrl = NodeURL.pathToFileURL(NodePath.join(workspacePath, "index.html")).href;
    const sensitiveUrl = NodeURL.pathToFileURL(NodePath.join(workspacePath, ".env")).href;

    await expect(validateResumeUrl(safeUrl)).resolves.toBe(safeUrl);
    await expect(validateResumeUrl(sensitiveUrl)).resolves.toBeNull();
    await expect(validateResumeUrl("file://attacker/share/page.html")).resolves.toBeNull();
  });

  it("distinguishes file paths from domains and search text", () => {
    expect(looksLikeFilePath("./page.html")).toBe(true);
    expect(looksLikeFilePath("sub/page.html")).toBe(true);
    expect(looksLikeFilePath("example.com/page.html")).toBe(false);
    expect(looksLikeFilePath("best coffee nearby")).toBe(false);
  });
});
