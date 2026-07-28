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
const directNodeCommandPattern = /(?:^|(?:&&|\|\||;)\s*)node(?:\.exe)?(?=\s|$)/m;

function extractRunCommands(source) {
  const lines = source.split(/\r?\n/);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = line.match(/^\s*run:\s*(.+)$/);
    if (inline && !/^[|>][-+]?\s*$/.test(inline[1])) {
      commands.push(inline[1]);
      continue;
    }
    if (!/^\s*run:\s*[|>][-+]?\s*$/.test(line)) continue;
    const runIndent = line.match(/^\s*/)[0].length;
    for (index += 1; index < lines.length; index += 1) {
      const blockLine = lines[index];
      if (blockLine.trim() && blockLine.match(/^\s*/)[0].length <= runIndent) {
        index -= 1;
        break;
      }
      commands.push(blockLine.trimStart());
    }
  }
  return commands.join("\n");
}

test("direct Node detection only matches shell command tokens", () => {
  for (const fixture of [
    "run: node --version",
    "run: node ./script.mjs",
    "run: node -p \"1 + 1\"",
    "run: |\n  echo ready\n  node --version",
    "run: bun run lint && node ./script.mjs",
  ]) {
    assert.match(extractRunCommands(fixture), directNodeCommandPattern, fixture);
  }
  for (const fixture of [
    "name: node --version",
    "node-version: 24.18.0",
    "run: bun node --version",
    "run: echo node ./script.mjs",
    "run: ./node-script.mjs",
  ]) {
    assert.doesNotMatch(extractRunCommands(fixture), directNodeCommandPattern, fixture);
  }
});

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
      assert.doesNotMatch(source, /package-manager-cache\s*:/i, file);
      assert.match(source, /run:\s*bun[^\r\n]*ci-package\.mjs/i, file);
      assert.ok(
        source.indexOf("actions/setup-node@") < source.indexOf("ci-package.mjs"),
        `${file}: Node setup must precede ci-package`,
      );
    } else {
      assert.doesNotMatch(source, /actions\/setup-node@/i, file);
      assert.doesNotMatch(source, /\bnode-version\s*:/i, file);
      assert.doesNotMatch(extractRunCommands(source), directNodeCommandPattern, file);
    }
  }
});
