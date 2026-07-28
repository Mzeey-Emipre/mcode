/** Tests that repository workflows use Bun without the removed Node contract. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const workflowDirectory = join(process.cwd(), ".github", "workflows");

test("workflows use Bun runtime and repository commands", () => {
  const workflowFiles = readdirSync(workflowDirectory)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();

  assert.ok(workflowFiles.length > 0);
  for (const file of workflowFiles) {
    const source = readFileSync(join(workflowDirectory, file), "utf8");
    assert.doesNotMatch(source, /actions\/setup-node@/i, file);
    assert.doesNotMatch(source, /\.node-version/i, file);
    assert.doesNotMatch(
      source,
      /^\s*(?:run:\s*)?node(?:\s+(?:scripts|apps\/[^\s]+\/scripts)|\s+<<|\s+-e)/im,
      file,
    );
    assert.match(source, /oven-sh\/setup-bun@v2/, file);
  }
});
