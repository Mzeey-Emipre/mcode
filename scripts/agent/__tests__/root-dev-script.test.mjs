/**
 * Tests for root package development entry points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("root dev uses the paired dev:web runtime", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

  assert.equal(packageJson.scripts.dev, "node scripts/dev-web.mjs");
});
