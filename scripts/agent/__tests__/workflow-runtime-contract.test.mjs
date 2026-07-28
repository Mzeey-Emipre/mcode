/** Tests that repository workflows use Bun with a packaging-only Node exception. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const workflowDirectory = join(process.cwd(), ".github", "workflows");
const packagingWorkflowAllowlist = new Set([
  "build-release.yml",
  "desktop-package-dry-run.yml",
  "nightly-desktop.yml",
]);
const directNodeCommandPattern = /^\s*(?:run:\s*)?node(?:\.exe)?(?:\s|$)/m;

test("workflows use Bun runtime and repository commands", () => {
  const workflowFiles = readdirSync(workflowDirectory)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();

  assert.ok(workflowFiles.length > 0);
  const packageConsumers = workflowFiles.filter((file) =>
    readFileSync(join(workflowDirectory, file), "utf8").includes("ci-package.mjs"),
  );
  assert.deepEqual(packageConsumers, [...packagingWorkflowAllowlist].sort());

  for (const file of workflowFiles) {
    const source = readFileSync(join(workflowDirectory, file), "utf8");
    assert.doesNotMatch(source, /\.node-version/i, file);
    assert.match(source, /oven-sh\/setup-bun@v2/, file);

    if (packagingWorkflowAllowlist.has(file)) {
      assert.equal((source.match(/actions\/setup-node@/gi) ?? []).length, 1, file);
      assert.match(source, /actions\/setup-node@v\d+/i, file);
      assert.match(source, /node-version:\s*["']?24\.18\.0["']?(?:\s|$)/i, file);
      assert.match(source, /run:\s*bun[^\r\n]*ci-package\.mjs/i, file);
      assert.ok(
        source.indexOf("actions/setup-node@") < source.indexOf("ci-package.mjs"),
        `${file}: Node setup must precede ci-package`,
      );
    } else {
      assert.doesNotMatch(source, /actions\/setup-node@/i, file);
      assert.doesNotMatch(source, /\bnode-version\s*:/i, file);
      assert.doesNotMatch(source, directNodeCommandPattern, file);
    }
  }
});
