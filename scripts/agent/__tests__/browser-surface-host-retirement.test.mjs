/** Proves that the retired native Browser host cannot return to current source or documentation. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { test } from "node:test";

const repositoryRoot = process.cwd();
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const legacyMigrationFixtures = new Set([
  "apps/server/src/features/settings/__tests__/settings-service.test.ts",
  "packages/contracts/src/models/__tests__/settings.test.ts",
]);
const supersededDecision = "docs/adr/0016-preview-rendering-host-switch.md";
const retiredRuntimePattern =
  /\bWebContentsView\b|\bwebContentsView\b|\bPreviewRenderingHost\b|\bPREVIEW_RENDERING_HOSTS\b|\brenderingHost\b|\bnativeHost\b|\brendererHost\b|preview:design\.(?:set-viewport|set-presentation|reset-viewport)/;
const retiredDocumentationPattern = /\bWebContentsView\b|\bwebContentsView\b/;

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function matchingFiles(roots, pattern, include) {
  return roots.flatMap((root) => listFiles(join(repositoryRoot, root)))
    .filter(include)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map(repositoryPath)
    .sort();
}

test("current source contains no retired Browser host path or identifier", () => {
  assert.equal(
    existsSync(join(repositoryRoot, "apps/desktop/src/main/preview/preview-lifecycle.ts")),
    false,
    "the retired native lifecycle module still exists",
  );

  const matches = matchingFiles(
    ["apps", "packages"],
    retiredRuntimePattern,
    (path) => sourceExtensions.has(extname(path)) && !legacyMigrationFixtures.has(repositoryPath(path)),
  );
  assert.deepEqual(matches, []);
});

test("current documentation describes BrowserSurfaceHost as the only host", () => {
  const matches = matchingFiles(
    ["docs"],
    retiredDocumentationPattern,
    (path) => extname(path) === ".md" && repositoryPath(path) !== supersededDecision,
  );
  assert.deepEqual(matches, []);

  const decision = readFileSync(join(repositoryRoot, supersededDecision), "utf8");
  assert.match(decision, /^Status: Superseded$/m);
  assert.match(decision, /BrowserSurfaceHost/);
});
