/** Tests for the repository Node runtime contract. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  readRequiredNodeVersion,
  validateNodeRuntime,
} from "../../node-runtime.mjs";

function runtimeFixture(version = "20.20.0") {
  const rootDir = mkdtempSync(resolve(tmpdir(), "mcode-node-runtime-"));
  writeFileSync(resolve(rootDir, ".node-version"), `${version}\n`);
  writeFileSync(resolve(rootDir, "package.json"), JSON.stringify({
    engines: { node: version },
  }));
  return rootDir;
}

test("reads the exact required version from .node-version", () => {
  const rootDir = runtimeFixture();
  try {
    assert.equal(readRequiredNodeVersion({ rootDir }), "20.20.0");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime mismatch reports expected, actual, executable, and recovery", () => {
  const rootDir = runtimeFixture();
  const lines = [];
  try {
    const result = validateNodeRuntime({
      rootDir,
      actualVersion: "v26.5.0",
      execPath: "C:\\tools\\node.exe",
      printer: (line) => lines.push(line),
    });
    assert.equal(result.ok, false);
    assert.equal(result.expectedVersion, "20.20.0");
    assert.match(lines.join("\n"), /Expected: v20\.20\.0/);
    assert.match(lines.join("\n"), /Actual: v26\.5\.0/);
    assert.match(lines.join("\n"), /Executable: C:\\tools\\node\.exe/);
    assert.match(lines.join("\n"), /Switch to Node 20\.20\.0/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("matching runtime passes without output", () => {
  const rootDir = runtimeFixture();
  const lines = [];
  try {
    const result = validateNodeRuntime({
      rootDir,
      actualVersion: "v20.20.0",
      execPath: "/tools/node",
      printer: (line) => lines.push(line),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(lines, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("package engine must match .node-version", () => {
  const rootDir = runtimeFixture();
  try {
    writeFileSync(resolve(rootDir, "package.json"), JSON.stringify({
      engines: { node: "20.20.1" },
    }));
    assert.throws(
      () => readRequiredNodeVersion({ rootDir }),
      /package\.json engines\.node must match \.node-version/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
