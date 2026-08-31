#!/usr/bin/env bun
/**
 * Deletes the historical rolling `nightly` GitHub release and its 49 stale
 * assets, leaving per-build nightly releases (v*-nightly.*) untouched.
 *
 * Usage:
 *   GH_TOKEN=$(gh auth token) bun scripts/agent/one-time-cleanup-rolling-nightly.mjs --confirm
 *
 * Without --confirm, prints what would be deleted but takes no action.
 */

import * as NodeChildProcess from "node:child_process";

const REPO = "mzeey-empire/mcode";
const TAG = "nightly";
const confirm = process.argv.includes("--confirm");

function gh(args) {
  return NodeChildProcess.execFileSync("gh", args, { encoding: "utf8" });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

let release;
try {
  release = ghJson([
    "release", "view", TAG, "--repo", REPO,
    "--json", "tagName,isPrerelease,assets",
  ]);
} catch {
  console.log(`Rolling '${TAG}' release not present on ${REPO} — nothing to do.`);
  process.exit(0);
}

if (release.tagName !== TAG) {
  throw new Error(
    `Refusing to delete: gh returned tagName="${release.tagName}" but expected "${TAG}". Aborting.`,
  );
}

console.log(`Found release: tag=${release.tagName} prerelease=${release.isPrerelease} assets=${release.assets.length}`);
for (const a of release.assets) {
  console.log(`  - ${a.name}`);
}

if (!confirm) {
  console.log("\nDry run. Re-run with --confirm to delete the release and all its assets.");
  process.exit(0);
}

console.log("\nDeleting release (this also removes the tag) ...");
gh(["release", "delete", TAG, "--repo", REPO, "--yes", "--cleanup-tag"]);
console.log("Done.");
