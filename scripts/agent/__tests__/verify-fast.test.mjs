/** Compatibility coverage for the retired fast-gate entry point. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FAST_PHASES } from "../verify-fast.mjs";

test("verify-fast no longer defines a weaker phase set", () => {
  assert.deepEqual(FAST_PHASES, []);
});
