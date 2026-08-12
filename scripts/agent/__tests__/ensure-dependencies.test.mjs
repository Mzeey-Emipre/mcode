import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { ensureDependencies } from "../ensure-dependencies.mjs";

test("skips installation when node_modules exists", () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), "mcode-dependencies-"));
  mkdirSync(resolve(repoRoot, "node_modules"));
  let calls = 0;

  try {
    const result = ensureDependencies({
      repoRoot,
      install: () => {
        calls += 1;
        return { status: 0 };
      },
    });

    assert.deepEqual(result, { installed: false });
    assert.equal(calls, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("installs dependencies once when node_modules is missing", () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), "mcode-dependencies-"));
  let calls = 0;

  try {
    const result = ensureDependencies({
      repoRoot,
      install: (cwd) => {
        calls += 1;
        assert.equal(cwd, repoRoot);
        mkdirSync(resolve(repoRoot, "node_modules"));
        return { status: 0 };
      },
    });

    assert.deepEqual(result, { installed: true });
    assert.equal(calls, 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("fails when installation does not create node_modules", () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), "mcode-dependencies-"));

  try {
    assert.throws(
      () => ensureDependencies({ repoRoot, install: () => ({ status: 0 }) }),
      /node_modules is still missing/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
