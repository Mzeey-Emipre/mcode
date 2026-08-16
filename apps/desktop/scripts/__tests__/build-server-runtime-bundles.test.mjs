import { afterEach, describe, expect, it } from "vitest";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServerRuntimeBundles } from "../../../../scripts/build-server-dev-bundle.mjs";

describe("buildServerRuntimeBundles", () => {
  let fixtureRoot;

  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("emits separate server and PTY host bundles", async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "server-runtime-bundles-"));
    const serverRoot = path.join(fixtureRoot, "server");
    const serverEntry = path.join(serverRoot, "dist-tsc", "index.js");
    const ptyHostEntry = path.join(
      serverRoot,
      "dist-tsc",
      "features",
      "terminal",
      "host",
      "pty-host-entry.js",
    );
    const serverOutFile = path.join(fixtureRoot, "dist", "server.cjs");
    const ptyHostOutFile = path.join(fixtureRoot, "dist", "pty-host.cjs");

    await mkdir(path.dirname(ptyHostEntry), { recursive: true });
    await writeFile(serverEntry, 'console.log("server-entry");\n');
    await writeFile(ptyHostEntry, 'console.log("pty-host-entry");\n');

    await buildServerRuntimeBundles({
      serverRoot,
      serverOutFile,
      ptyHostOutFile,
      production: true,
    });

    await access(serverOutFile);
    await access(ptyHostOutFile);
    expect(await readFile(serverOutFile, "utf8")).toContain("server-entry");
    expect(await readFile(ptyHostOutFile, "utf8")).toContain("pty-host-entry");
  }, 30_000);
});
