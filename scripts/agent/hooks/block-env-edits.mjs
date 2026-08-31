#!/usr/bin/env bun
/**
 * Blocks direct edits to `.env` files from agent tool hooks.
 */

import * as NodeURL from "node:url";

const CODEX_FLAG = "--codex";

/**
 * Extracts string values from a parsed hook payload.
 *
 * @param {unknown} value Hook payload value.
 * @returns {string[]} String leaves from the payload.
 */
export function collectStringValues(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  return Object.values(value).flatMap(collectStringValues);
}

/**
 * Returns true when the path targets a protected `.env` file.
 *
 * @param {string} value Candidate path from hook input.
 * @returns {boolean} Whether the path should be blocked.
 */
export function isProtectedEnvPath(value) {
  const normalized = value.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? "";
  if (basename === ".env.example") return false;
  return basename === ".env" || basename.startsWith(".env.");
}

/**
 * Finds protected `.env` paths in the raw hook input.
 *
 * @param {string} rawInput Raw TOOL_INPUT value.
 * @returns {string[]} Protected paths found in the input.
 */
export function findProtectedEnvPaths(rawInput) {
  let parsed;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    parsed = rawInput;
  }
  return collectStringValues(parsed).filter(isProtectedEnvPath);
}

function main() {
  const protectedPaths = findProtectedEnvPaths(process.env.TOOL_INPUT ?? "");
  if (protectedPaths.length === 0) return;

  const reason = "Do not edit .env files directly. Update .env.example instead.";
  if (process.argv.includes(CODEX_FLAG)) {
    console.log(JSON.stringify({ decision: "block", reason }));
    return;
  }

  console.error(`BLOCK: ${reason}`);
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
