/**
 * Tests for the demo dev-server port picker.
 *
 * `demo.mjs` assumes the default port (5173) may be in use and claims the first
 * free one, then boots an isolated stack there — this is what stops a demo from
 * reusing a stale page wired to the wrong (even production) server. These tests
 * pin that helper's contract: it returns a bindable port and skips occupied ones.
 *
 * Uses Node's built-in test runner (`node:test`); no extra dev dep required.
 * Run with `node --test scripts/agent/__tests__/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { findFreePort } from "../demo.mjs";

/** Bind a listening socket on `port` (IPv4 loopback) so the port reads as busy. */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

test("findFreePort returns a bindable port at or above the preferred", async () => {
  const base = 53120;
  const got = await findFreePort(base);
  assert.ok(got >= base, `expected >= ${base}, got ${got}`);
  // The returned port must actually be bindable.
  const srv = await occupy(got);
  srv.close();
});

test("findFreePort skips an occupied port", async () => {
  const base = 53210;
  const srv = await occupy(base);
  try {
    const got = await findFreePort(base);
    assert.ok(got > base, `expected a port above ${base}, got ${got}`);
  } finally {
    srv.close();
  }
});
