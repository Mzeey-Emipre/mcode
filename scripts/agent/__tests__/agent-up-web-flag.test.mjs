import assert from "node:assert/strict";
import { test } from "node:test";
import { isWebAutomationEnabled } from "../agent-up.mjs";

test("web automation forwarding stays disabled unless explicitly enabled", () => {
  assert.equal(isWebAutomationEnabled({}), false);
  assert.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "0" }), false);
  assert.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "true" }), true);
  assert.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "1" }), true);
});
