import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import { probeCdpVersion } from "../../../.codex/skills/electorn-live-testing/scripts/start-electron.mjs";

const validCdpVersion = {
  Browser: "Electron/37.3.1",
  "Protocol-Version": "1.3",
  webSocketDebuggerUrl: "ws://127.0.0.1:43000/devtools/browser/session",
};

NodeTest.test("bounds a fetch that never settles", async () => {
  const startedAt = performance.now();
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    timeoutMs: 20,
    fetchImpl: async () => new Promise(() => {}),
  });

  NodeAssertStrict.default.equal(ready, false);
  NodeAssertStrict.default.ok(performance.now() - startedAt < 500);
});

NodeTest.test("rejects an HTTP 200 response without CDP metadata", async () => {
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok" }) }),
  });

  NodeAssertStrict.default.equal(ready, false);
});

NodeTest.test("accepts a valid CDP version response", async () => {
  const ready = await probeCdpVersion("http://127.0.0.1:43000", {
    fetchImpl: async () => ({ ok: true, json: async () => validCdpVersion }),
  });

  NodeAssertStrict.default.equal(ready, true);
});
