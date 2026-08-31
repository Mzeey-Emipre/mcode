#!/usr/bin/env bun
/**
 * Copy the project's Codex prompts (.codex/prompts/*.md) into the user's
 * Codex CLI prompt directory (~/.codex/prompts/) so they appear in Codex's
 * slash menu.
 *
 * Codex CLI does not read project-local slash commands (only user-level
 * prompts under ~/.codex/prompts/). This is a one-time bootstrap each
 * developer runs on their machine.
 *
 * Skipped files: any with the same name already present (use --force to
 * overwrite). Prompts are prefixed with `mcode-` in the destination to
 * avoid colliding with other projects' prompts.
 *
 * Usage:
 *   bun scripts/agent/install-codex-prompts.mjs           # safe install
 *   bun scripts/agent/install-codex-prompts.mjs --force   # overwrite
 *   bun scripts/agent/install-codex-prompts.mjs --no-prefix
 *     # install without the `mcode-` prefix (collision risk)
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

const FORCE = process.argv.includes("--force");
const NO_PREFIX = process.argv.includes("--no-prefix");
const PREFIX = NO_PREFIX ? "" : "mcode-";
const SRC = NodePath.resolve(process.cwd(), ".codex", "prompts");
const DST = NodePath.join(NodeOS.homedir(), ".codex", "prompts");
const RETIRED_PROMPTS = [
  "mcode-demo.md",
  "mcode-demo-desktop.md",
  "mcode-verify-e2e.md",
  "mcode-verify-e2e-desktop.md",
  "mcode-review-pr.md",
];

if (!NodeFS.existsSync(SRC)) {
  console.error(`[codex-install] missing source dir: ${SRC}`);
  console.error("[codex-install] run this from the repo root");
  process.exit(1);
}

NodeFS.mkdirSync(DST, { recursive: true });

for (const retiredPrompt of RETIRED_PROMPTS) {
  const retiredPath = NodePath.join(DST, retiredPrompt);
  if (!NodeFS.existsSync(retiredPath)) continue;
  NodeFS.rmSync(retiredPath);
  console.log(`[codex-install] removed retired prompt ${retiredPrompt}`);
}

if (NO_PREFIX) {
  console.log(
    "[codex-install] remove unprefixed demo and verify-e2e prompts manually if this project installed them previously.",
  );
}

const files = NodeFS.readdirSync(SRC).filter((f) => f.endsWith(".md"));
let installed = 0;
let skipped = 0;

for (const f of files) {
  const srcPath = NodePath.join(SRC, f);
  const dstName = `${PREFIX}${f}`;
  const dstPath = NodePath.join(DST, dstName);

  if (NodeFS.existsSync(dstPath) && !FORCE) {
    console.log(`[codex-install] skip ${dstName} (exists; --force to overwrite)`);
    skipped += 1;
    continue;
  }

  NodeFS.writeFileSync(dstPath, NodeFS.readFileSync(srcPath));
  console.log(`[codex-install] installed ${dstName}`);
  installed += 1;
}

console.log("");
console.log(`[codex-install] dest: ${DST}`);
console.log(`[codex-install] installed: ${installed}, skipped: ${skipped}`);
console.log(
  `[codex-install] invoke from Codex as /${PREFIX}verify.`,
);
