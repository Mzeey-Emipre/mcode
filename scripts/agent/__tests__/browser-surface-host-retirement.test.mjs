/** Proves that the retired native Browser host cannot return to current source or documentation. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const repositoryRoot = process.cwd();
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const nonSourceDirectories = new Set([
  "node_modules",
  "dist",
  "dist-tsc",
  "out",
  "release",
  ".turbo",
]);
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
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory() && !nonSourceDirectories.has(entry.name)) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function repositoryPath(path) {
  return NodePath.relative(repositoryRoot, path).replaceAll("\\", "/");
}

function matchingFiles(roots, pattern, include) {
  return roots.flatMap((root) => listFiles(NodePath.join(repositoryRoot, root)))
    .filter(include)
    .filter((path) => pattern.test(NodeFS.readFileSync(path, "utf8")))
    .map(repositoryPath)
    .sort();
}

NodeTest.test("current source contains no retired Browser host path or identifier", () => {
  NodeAssertStrict.default.equal(
    NodeFS.existsSync(NodePath.join(repositoryRoot, "apps/desktop/src/main/preview/preview-lifecycle.ts")),
    false,
    "the retired native lifecycle module still exists",
  );

  const matches = matchingFiles(
    ["apps", "packages"],
    retiredRuntimePattern,
    (path) => sourceExtensions.has(NodePath.extname(path)) && !legacyMigrationFixtures.has(repositoryPath(path)),
  );
  NodeAssertStrict.default.deepEqual(matches, []);
});

NodeTest.test("current documentation describes BrowserSurfaceHost as the only host", () => {
  const matches = matchingFiles(
    ["docs"],
    retiredDocumentationPattern,
    (path) => NodePath.extname(path) === ".md" && repositoryPath(path) !== supersededDecision,
  );
  NodeAssertStrict.default.deepEqual(matches, []);

  const decision = NodeFS.readFileSync(NodePath.join(repositoryRoot, supersededDecision), "utf8");
  NodeAssertStrict.default.match(decision, /^Status: Superseded$/m);
  NodeAssertStrict.default.match(decision, /BrowserSurfaceHost/);
});
