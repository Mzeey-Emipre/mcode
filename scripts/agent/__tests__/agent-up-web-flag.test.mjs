import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";
import { buildWebAutomationEnv, isWebAutomationEnabled } from "../agent-up.mjs";

NodeTest.test("web automation forwarding stays disabled unless explicitly enabled", () => {
  NodeAssertStrict.default.equal(isWebAutomationEnabled({}), false);
  NodeAssertStrict.default.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "0" }), false);
  NodeAssertStrict.default.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "true" }), true);
  NodeAssertStrict.default.equal(isWebAutomationEnabled({ MCODE_WEB_AUTOMATION: "1" }), true);
});

NodeTest.test("web automation opt-in is forwarded to both runtime children", () => {
  NodeAssertStrict.default.deepEqual(buildWebAutomationEnv({ MCODE_WEB_AUTOMATION: "1" }), {
    MCODE_WEB_AUTOMATION: "1",
    VITE_MCODE_WEB_AUTOMATION: "1",
  });
  NodeAssertStrict.default.deepEqual(buildWebAutomationEnv({ MCODE_WEB_AUTOMATION: "0" }), {
    MCODE_WEB_AUTOMATION: "0",
    VITE_MCODE_WEB_AUTOMATION: "0",
  });
});
