/** Tests process-tree termination sequencing and graceful-exit guards. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { killProcessTree } from "../../kill-process-tree.mjs";

test("graceful child exit suppresses delayed hard kill", async () => {
  const originalKill = process.kill;
  const originalPlatform = process.platform;
  const signals = [];
  const child = { pid: 12345, exitCode: null, signalCode: null };
  process.platform = "linux";
  process.kill = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === "SIGTERM") child.exitCode = 0;
    return true;
  };

  try {
    await killProcessTree(child, { graceMs: 20, useProcessGroup: true });
    assert.deepEqual(signals, [[-12345, "SIGTERM"]]);
  } finally {
    process.kill = originalKill;
    process.platform = originalPlatform;
  }
});
