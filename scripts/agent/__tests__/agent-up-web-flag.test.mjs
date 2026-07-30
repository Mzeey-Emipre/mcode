import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWebAutomationEnv, isWebAutomationEnabled } from "../agent-up.mjs";

test("web automation forwarding stays disabled unless explicitly enabled", () => {
  assert.equal(isWebAutomationEnabled({}), false);
  assert.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "0" }), false);
  assert.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "true" }), true);
  assert.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "1" }), true);
});

test("web automation opt-in is forwarded to both runtime children", () => {
  assert.deepEqual(buildWebAutomationEnv({ MCODE_WEB_AUTOMATION: "1" }), {
    MCODE_WEB_AUTOMATION: "1",
    VITE_MCODE_WEB_AUTOMATION: "1",
  });
  assert.deepEqual(buildWebAutomationEnv({ MCODE_WEB_AUTOMATION: "0" }), {
    MCODE_WEB_AUTOMATION: "0",
    VITE_MCODE_WEB_AUTOMATION: "0",
  });
});
