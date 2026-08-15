/** Tests that repository workflows use Bun with a packaging-only Node exception. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const workflowDirectory = join(process.cwd(), ".github", "workflows");
const packagingWorkflowAllowlist = new Set([
  "desktop-package-target.yml",
]);
const bunCheckoutJobs = new Map();
const directNodeCommandPattern = /(?:^|(?:&&|\|\||;)\s*)node(?:\.exe)?(?=\s|$)/m;
const directBunStdinPattern = /^\s*bun(?:\.exe)?\s+<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?\s*$/m;

function extractWorkflowJob(source, jobName) {
  const jobStart = source.indexOf(`  ${jobName}:`);
  if (jobStart < 0) return null;
  const bodyStart = source.indexOf("\n", jobStart) + 1;
  if (bodyStart === 0) return null;
  const nextJobOffset = source.slice(bodyStart).search(/^  [A-Za-z0-9_-]+:/m);
  return source.slice(bodyStart, nextJobOffset < 0 ? source.length : bodyStart + nextJobOffset);
}

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

test("direct Bun stdin detection rejects unsupported heredocs", () => {
  for (const fixture of [
    "run: bun <<'NODE'",
    "run: |\n  bun <<-NODE\n  console.log('unsupported')",
    "run: bun.exe <<NODE",
  ]) {
    assert.match(extractRunCommands(fixture), directBunStdinPattern, fixture);
  }
  for (const fixture of [
    "run: bun -e \"$(cat <<'NODE'\nconsole.log('supported')\nNODE\n)\"",
    "run: bun run script.mjs",
  ]) {
    assert.doesNotMatch(extractRunCommands(fixture), directBunStdinPattern, fixture);
  }
});

test("renderer performance keeps Electron available for its runtime", () => {
  const source = readFileSync(join(workflowDirectory, "ci.yml"), "utf8");
  const jobSource = extractWorkflowJob(source, "renderer-performance");

  assert.ok(jobSource, "ci.yml: renderer-performance job missing");
  assert.doesNotMatch(jobSource, /SKIP_ELECTRON_REBUILD\s*:/);
  assert.doesNotMatch(jobSource, /ELECTRON_SKIP_BINARY_DOWNLOAD\s*:/);
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
    assert.doesNotMatch(extractRunCommands(source), directBunStdinPattern, file);

    const bunCheckoutJob = bunCheckoutJobs.get(file);
    if (bunCheckoutJob) {
      const jobSource = extractWorkflowJob(source, bunCheckoutJob);
      assert.ok(jobSource, `${file}: ${bunCheckoutJob} job missing`);
      const checkoutIndex = jobSource.indexOf("actions/checkout@v4");
      const setupBunIndex = jobSource.indexOf("oven-sh/setup-bun@v2");
      assert.ok(checkoutIndex >= 0, `${file}: ${bunCheckoutJob} must checkout repository`);
      assert.ok(setupBunIndex >= 0, `${file}: ${bunCheckoutJob} must setup Bun`);
      assert.ok(
        checkoutIndex < setupBunIndex,
        `${file}: ${bunCheckoutJob} checkout must precede setup-bun`,
      );
    }

    if (packagingWorkflowAllowlist.has(file)) {
      assert.equal((source.match(/actions\/setup-node@/gi) ?? []).length, 1, file);
      assert.match(source, /actions\/setup-node@v\d+/i, file);
      assert.match(source, /node-version:\s*["']?24\.18\.0["']?(?:\s|$)/i, file);
      assert.doesNotMatch(source, /package-manager-cache\s*:/i, file);
      assert.match(
        extractRunCommands(source),
        /bun[^\r\n]*desktop-packaging\/target-package\/ci-package\.mjs/i,
        file,
      );
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
