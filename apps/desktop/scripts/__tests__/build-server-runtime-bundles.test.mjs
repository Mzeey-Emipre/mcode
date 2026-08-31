import { afterEach, describe, expect, it } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import {
  buildServerRuntimeBundles,
  compileServerWithSwc,
} from "../../../../scripts/build-server-dev-bundle.mjs";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");

describe("buildServerRuntimeBundles", () => {
  let fixtureRoot;

  afterEach(async () => {
    if (fixtureRoot) await NodeFSPromises.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("compiles the server entry as valid CommonJS", async () => {
    const serverRoot = NodePath.join(repoRoot, "apps/server");
    const distTsc = NodePath.join(serverRoot, "dist-tsc");
    const outputRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "server-entry-cjs-"));
    const serverOutFile = NodePath.join(outputRoot, "server.cjs");
    const ptyHostOutFile = NodePath.join(outputRoot, "pty-host.cjs");

    try {
      compileServerWithSwc(serverRoot);
      await buildServerRuntimeBundles({
        serverRoot,
        serverOutFile,
        ptyHostOutFile,
      });
      const bundledEntry = await NodeFSPromises.readFile(serverOutFile, "utf8");

      expect(() => new NodeVM.Script(bundledEntry, { filename: "server.cjs" })).not.toThrow();
    } finally {
      await NodeFSPromises.rm(outputRoot, { recursive: true, force: true });
      await NodeFSPromises.rm(distTsc, { recursive: true, force: true });
    }
  }, 30_000);

  it("emits separate server and PTY host bundles", async () => {
    fixtureRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "server-runtime-bundles-"));
    const serverRoot = NodePath.join(fixtureRoot, "server");
    const serverEntry = NodePath.join(serverRoot, "dist-tsc", "index.js");
    const ptyHostEntry = NodePath.join(
      serverRoot,
      "dist-tsc",
      "features",
      "terminal",
      "host",
      "pty-host-entry.js",
    );
    const serverOutFile = NodePath.join(fixtureRoot, "dist", "server.cjs");
    const ptyHostOutFile = NodePath.join(fixtureRoot, "dist", "pty-host.cjs");

    await NodeFSPromises.mkdir(NodePath.dirname(ptyHostEntry), { recursive: true });
    await NodeFSPromises.writeFile(serverEntry, 'console.log("server-entry");\n');
    await NodeFSPromises.writeFile(ptyHostEntry, 'console.log("pty-host-entry");\n');

    await buildServerRuntimeBundles({
      serverRoot,
      serverOutFile,
      ptyHostOutFile,
      production: true,
    });

    await NodeFSPromises.access(serverOutFile);
    await NodeFSPromises.access(ptyHostOutFile);
    expect(await NodeFSPromises.readFile(serverOutFile, "utf8")).toContain("server-entry");
    expect(await NodeFSPromises.readFile(ptyHostOutFile, "utf8")).toContain("pty-host-entry");
  }, 30_000);
});
