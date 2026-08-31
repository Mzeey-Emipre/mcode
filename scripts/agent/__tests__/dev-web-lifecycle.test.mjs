/** Tests the dev:server exit status mapping. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";
import { resolveServerOnlyExitCode } from "../../dev-web-lifecycle.mjs";

NodeTest.test("dev:server preserves numeric exit codes", () => {
  NodeAssertStrict.default.equal(resolveServerOnlyExitCode({ code: 23, signal: "SIGTERM", cleanupRequested: true }), 23);
  NodeAssertStrict.default.equal(resolveServerOnlyExitCode({ code: 0, signal: "SIGTERM", cleanupRequested: true }), 0);
});

NodeTest.test("dev:server maps expected cleanup signals to success", () => {
  NodeAssertStrict.default.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGINT", cleanupRequested: true }), 0);
  NodeAssertStrict.default.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGTERM", cleanupRequested: true }), 0);
});

NodeTest.test("dev:server maps unexpected or unrequested signals to failure", () => {
  NodeAssertStrict.default.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGKILL", cleanupRequested: true }), 1);
  NodeAssertStrict.default.equal(resolveServerOnlyExitCode({ code: null, signal: "SIGTERM", cleanupRequested: false }), 1);
  NodeAssertStrict.default.equal(resolveServerOnlyExitCode({ code: null, signal: null, cleanupRequested: false }), 1);
});
