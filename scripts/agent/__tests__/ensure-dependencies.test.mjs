import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { ensureDependencies } from "../ensure-dependencies.mjs";

NodeTest.test("skips installation when node_modules exists", () => {
  const repoRoot = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-dependencies-"));
  NodeFS.mkdirSync(NodePath.resolve(repoRoot, "node_modules"));
  let calls = 0;

  try {
    const result = ensureDependencies({
      repoRoot,
      install: () => {
        calls += 1;
        return { status: 0 };
      },
    });

    NodeAssertStrict.default.deepEqual(result, { installed: false });
    NodeAssertStrict.default.equal(calls, 0);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

NodeTest.test("installs dependencies once when node_modules is missing", () => {
  const repoRoot = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-dependencies-"));
  let calls = 0;

  try {
    const result = ensureDependencies({
      repoRoot,
      install: (cwd) => {
        calls += 1;
        NodeAssertStrict.default.equal(cwd, repoRoot);
        NodeFS.mkdirSync(NodePath.resolve(repoRoot, "node_modules"));
        return { status: 0 };
      },
    });

    NodeAssertStrict.default.deepEqual(result, { installed: true });
    NodeAssertStrict.default.equal(calls, 1);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

NodeTest.test("fails when installation does not create node_modules", () => {
  const repoRoot = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-dependencies-"));

  try {
    NodeAssertStrict.default.throws(
      () => ensureDependencies({ repoRoot, install: () => ({ status: 0 }) }),
      /node_modules is still missing/,
    );
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});
