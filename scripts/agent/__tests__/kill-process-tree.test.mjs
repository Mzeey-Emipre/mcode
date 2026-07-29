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

test("missing process group never falls back to a reused direct PID", async () => {
  const originalKill = process.kill;
  const originalPlatform = process.platform;
  const signals = [];
  process.platform = "linux";
  process.kill = (pid, signal) => {
    signals.push([pid, signal]);
    const error = new Error("process group missing");
    error.code = "ESRCH";
    throw error;
  };

  try {
    await killProcessTree({ pid: 12345, exitCode: null, signalCode: null }, {
      graceMs: 20,
      useProcessGroup: true,
    });
    assert.deepEqual(signals, [[-12345, "SIGTERM"], [-12345, 0]]);
  } finally {
    process.kill = originalKill;
    process.platform = originalPlatform;
  }
});

test("already-exited child receives no signal", async () => {
  const originalKill = process.kill;
  const originalPlatform = process.platform;
  const signals = [];
  process.platform = "linux";
  process.kill = (pid, signal) => {
    signals.push([pid, signal]);
    return true;
  };

  try {
    await killProcessTree({ pid: 12345, exitCode: 0, signalCode: null }, {
      graceMs: 20,
      useProcessGroup: true,
    });
    assert.deepEqual(signals, []);
  } finally {
    process.kill = originalKill;
    process.platform = originalPlatform;
  }
});

test("propagates non-ESRCH POSIX termination failures", async () => {
  const originalKill = process.kill;
  const originalPlatform = process.platform;
  process.platform = "linux";
  process.kill = () => {
    const error = new Error("permission denied");
    error.code = "EPERM";
    throw error;
  };

  try {
    await assert.rejects(
      () => killProcessTree({ pid: 12345, exitCode: null, signalCode: null }, {
        graceMs: 20,
        useProcessGroup: true,
      }),
      /permission denied/,
    );
  } finally {
    process.kill = originalKill;
    process.platform = originalPlatform;
  }
});
