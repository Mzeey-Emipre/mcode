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
import { Script } from "node:vm";
import {
  buildServerRuntimeBundles,
  compileServerWithSwc,
} from "../../../../scripts/build-server-dev-bundle.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe("buildServerRuntimeBundles", () => {
  let fixtureRoot;

  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("compiles the server entry as valid CommonJS", async () => {
    const serverRoot = path.join(repoRoot, "apps/server");
    const distTsc = path.join(serverRoot, "dist-tsc");
    const outputRoot = await mkdtemp(path.join(tmpdir(), "server-entry-cjs-"));
    const serverOutFile = path.join(outputRoot, "server.cjs");
    const ptyHostOutFile = path.join(outputRoot, "pty-host.cjs");

    try {
      compileServerWithSwc(serverRoot);
      await buildServerRuntimeBundles({
        serverRoot,
        serverOutFile,
        ptyHostOutFile,
      });
      const bundledEntry = await readFile(serverOutFile, "utf8");

      expect(() => new Script(bundledEntry, { filename: "server.cjs" })).not.toThrow();
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
      await rm(distTsc, { recursive: true, force: true });
    }
  }, 30_000);

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
