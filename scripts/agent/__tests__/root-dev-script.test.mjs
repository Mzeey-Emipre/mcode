/**
 * Tests for root package development entry points.
 */
import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { discoverAgentTestFiles, selectAgentTestFiles } from "../test-scripts.mjs";

NodeTest.test("root dev uses the paired dev:web runtime", () => {
  const packageJson = JSON.parse(NodeFS.readFileSync(NodePath.resolve("package.json"), "utf8"));

  NodeAssertStrict.default.equal(packageJson.scripts.dev, "bun run dev:web");
});

NodeTest.test("root dev:server runs only the Electron-backed server launcher", () => {
  const packageJson = JSON.parse(NodeFS.readFileSync(NodePath.resolve("package.json"), "utf8"));

  NodeAssertStrict.default.equal(packageJson.scripts["dev:server"], "bun scripts/dev-web.mjs --server-only");
});

NodeTest.test("root db:info dispatches to the Electron SQLite runtime", () => {
  const packageJson = JSON.parse(NodeFS.readFileSync(NodePath.resolve("package.json"), "utf8"));

  NodeAssertStrict.default.equal(packageJson.scripts["db:info"], "bun scripts/db-info.mjs");
});

NodeTest.test("repository orchestration scripts use Bun without a system Node contract", () => {
  const packageJson = JSON.parse(NodeFS.readFileSync(NodePath.resolve("package.json"), "utf8"));
  for (const name of [
    "postinstall",
    "setup",
    "doctor",
    "dev:web",
    "dev:server",
    "test",
    "test:scripts",
    "agent:setup",
    "agent:up",
    "agent:down",
    "agent:reset",
  ]) {
    NodeAssertStrict.default.doesNotMatch(packageJson.scripts[name], /\bnode(?:\.exe)?\b/);
  }
  NodeAssertStrict.default.equal(packageJson.engines, undefined);
});

NodeTest.test("agent commands no longer rely on lifecycle dependency hooks", () => {
  const packageJson = JSON.parse(NodeFS.readFileSync(NodePath.resolve("package.json"), "utf8"));
  NodeAssertStrict.default.equal(
    packageJson.scripts["deps:ensure"],
    "bun scripts/agent/ensure-dependencies.mjs",
  );
  for (const name of [
    "dev",
    "dev:desktop",
    "dev:web",
    "dev:server",
    "agent:setup",
    "agent:up",
    "agent:reset",
  ]) {
    NodeAssertStrict.default.equal(packageJson.scripts[`pre${name}`], undefined, name);
  }
});

NodeTest.test("maintained test discovery fails when no tests exist", () => {
  const directory = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-agent-tests-"));
  try {
    NodeAssertStrict.default.throws(
      () => discoverAgentTestFiles(directory),
      /No agent tests found/,
    );
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

NodeTest.test("maintained test selection runs only named files inside the agent test directory", () => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-agent-tests-"));
  const directory = NodePath.join(temporaryRoot, "agent-tests");
  const testFile = NodePath.join(directory, "focused.test.mjs");
  const nestedFile = NodePath.join(directory, "nested", "focused.test.mjs");
  const externalFile = NodePath.join(temporaryRoot, "outside.test.mjs");
  const directoryNamedAsTest = NodePath.join(directory, "directory.test.mjs");
  const linkedFile = NodePath.join(directory, "linked.test.mjs");
  try {
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(testFile, "");
    NodeFS.mkdirSync(NodePath.dirname(nestedFile));
    NodeFS.writeFileSync(nestedFile, "");
    NodeFS.writeFileSync(externalFile, "");
    NodeFS.mkdirSync(directoryNamedAsTest);
    NodeAssertStrict.default.deepEqual(selectAgentTestFiles(directory, [testFile]), [testFile]);
    NodeAssertStrict.default.throws(
      () => selectAgentTestFiles(directory, [nestedFile]),
      /Expected a maintained agent test file/,
    );
    NodeAssertStrict.default.throws(
      () => selectAgentTestFiles(directory, [externalFile]),
      /Expected a maintained agent test file/,
    );
    NodeAssertStrict.default.throws(
      () => selectAgentTestFiles(directory, [directoryNamedAsTest]),
      /Expected a maintained agent test file/,
    );
    try {
      NodeFS.symlinkSync(externalFile, linkedFile, "file");
      NodeAssertStrict.default.throws(
        () => selectAgentTestFiles(directory, [linkedFile]),
        /Expected a maintained agent test file/,
      );
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    }
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
