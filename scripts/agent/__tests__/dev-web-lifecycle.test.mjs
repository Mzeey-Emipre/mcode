/** Tests the dev:server exit status mapping. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServerOnlyExitCode } from "../../dev-web-lifecycle.mjs";

test("dev:server preserves numeric exit codes", () => {
  assert.equal(resolveServerOnlyExitCode({ code: 23, signal: "SIGTERM", cleanupRequested: true }), 23);
  assert.equal(resolveServerOnlyExitCode({ code: 0, signal: "SIGTERM", cleanupRequested: true }), 0);
});

test("dev:server maps expected cleanup signals to success", () => {
  assert.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGINT", cleanupRequested: true }), 0);
  assert.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGTERM", cleanupRequested: true }), 0);
});

test("dev:server maps unexpected or unrequested signals to failure", () => {
  assert.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGKILL", cleanupRequested: true }), 1);
  assert.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGTERM", cleanupRequested: false }), 1);
  assert.equal(resolveServerOnlyExitCode({ code: null, signal: null, cleanupRequested: false }), 1);
});
