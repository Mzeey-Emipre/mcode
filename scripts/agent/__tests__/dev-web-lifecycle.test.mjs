/** Tests the dev:server exit status mapping. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServerOnlyExitCode } from "../../dev-web-lifecycle.mjs";

test("dev:server reports unexpected signal exits as failures", () => {
  assert.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGTERM", cleanupRequested: false }), 1);
  assert.equal(resolveServerOnlyExitCode({ code: 23, signal: null, cleanupRequested: false }), 23);
  assert.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGTERM", cleanupRequested: true }), 0);
});
