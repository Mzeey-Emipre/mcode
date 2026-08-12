import { test } from "node:test";
import assert from "node:assert/strict";
import { probeCdpVersion } from "../../../.codex/skills/electorn-live-testing/scripts/start-electron.mjs";

const validCdpVersion = {
  Browser: "Electron/37.3.1",
  "Protocol-Version": "1.3",
  webSocketDebuggerUrl: "ws://127.0.0.1:43000/devtools/browser/session",
};

test("bounds a fetch that never settles", async () => {
  const startedAt = performance.now();
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    timeoutMs: 20,
    fetchImpl: async () => new Promise(() => {}),
  });

  assert.equal(ready, false);
  assert.ok(performance.now() - startedAt < 500);
});

test("rejects an HTTP 200 response without CDP metadata", async () => {
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok" }) }),
  });

  assert.equal(ready, false);
});

test("accepts a valid CDP version response", async () => {
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    fetchImpl: async () => ({ ok: true, json: async () => validCdpVersion }),
  });

  assert.equal(ready, true);
});
