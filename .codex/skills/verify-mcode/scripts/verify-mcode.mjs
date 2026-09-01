#!/usr/bin/env bun
/** Runs Mcode's focused verification areas through one public CLI. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const HELP = `Verify Mcode

Usage:
  bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs <area> <command> [options]

Areas:
  runtime <health|check|inspect|live|diagnostics|cleanup>
      Verify AgentService, provider events, turn runtime, and runtime cleanup.
  thread-lifecycle <health|check|proof|inspect|cleanup>
      Verify desktop thread completion and managed-worktree cleanup.
  desktop selected-text-comments <setup|proof|cleanup>
      Prepare, prove, or remove the Electron selected-text-comments fixture.

Examples:
  bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health
  bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs thread-lifecycle proof --confirm-cleanup
  bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments proof

Run an area command with --help for its options and proof limits.`;

const SELECTED_TEXT_COMMENTS_HELP = `Verify Mcode desktop selected-text comments

Usage:
  bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments <setup|proof|cleanup>

Commands:
  setup
      Create the stopped-Electron fixture.
  proof
      Capture the selected-text comments proof in Electron.
  cleanup
      Remove only the selected-text comments fixture.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const child = resolveChild(args);
  if (child.help) {
    process.stdout.write(`${child.help}\n`);
    return 0;
  }
  return await run(child.script, child.args);
}

function resolveChild(args) {
  const [area, ...rest] = args;
  if (area === "runtime") return { script: "runtime.mjs", args: rest };
  if (area === "thread-lifecycle") return { script: "thread-lifecycle.mjs", args: rest };
  if (area === "desktop") return resolveDesktopChild(rest);
  throw usageError(`Unknown verification area: ${String(area)}`);
}

function resolveDesktopChild(args) {
  const [feature, command, ...rest] = args;
  if (feature === "--help" || feature === "-h") return { help: SELECTED_TEXT_COMMENTS_HELP };
  if (feature !== "selected-text-comments") {
    throw usageError(`Unknown desktop feature: ${String(feature)}`);
  }
  if (command === "--help" || command === "-h") return { help: SELECTED_TEXT_COMMENTS_HELP };
  if (rest.length > 0 || !["setup", "proof", "cleanup"].includes(command)) {
    throw usageError("desktop selected-text-comments requires setup, proof, or cleanup without options");
  }
  if (command === "proof") return { script: "verify-selected-text-comments.mjs", args: [] };
  return { script: "selected-text-comments-fixture.mjs", args: [command] };
}

async function run(script, args) {
  const path = NodePath.join(import.meta.dirname, script);
  return await new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [path, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`Verification command stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function usageError(condition) {
  return new Error(`Condition: ${condition}. Next action: Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs --help.`);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
