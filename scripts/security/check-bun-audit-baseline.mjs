#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_PATH = resolve(ROOT, "docs", "security", "bun-audit-baseline.json");
const WRITE_MODE = process.argv.includes("--write");

function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error("bun audit did not print JSON");
  }

  const state = { depth: 0, inString: false, escaped: false };

  for (let i = start; i < text.length; i += 1) {
    if (scanJsonCharacter(state, text[i])) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }

  throw new Error("bun audit JSON was incomplete");
}

function scanJsonCharacter(state, character) {
  if (state.inString) return scanStringCharacter(state, character);
  if (character === "\"") {
    state.inString = true;
  } else if (character === "{") {
    state.depth += 1;
  } else if (character === "}") {
    state.depth -= 1;
  }
  return state.depth === 0;
}

function scanStringCharacter(state, character) {
  if (state.escaped) {
    state.escaped = false;
  } else if (character === "\\") {
    state.escaped = true;
  } else if (character === "\"") {
    state.inString = false;
  }
  return false;
}

function runAudit() {
  const result = spawnSync("bun", ["audit", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return extractJsonObject(output);
}

function flattenAudit(audit) {
  return Object.entries(audit)
    .flatMap(([packageName, advisories]) =>
      advisories.map((advisory) => ({
        key: `${packageName}:${advisory.id}`,
        package: packageName,
        id: advisory.id,
        severity: advisory.severity,
        title: advisory.title,
        url: advisory.url,
      })),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
}

function severitySummary(advisories) {
  const summary = new Map();
  for (const advisory of advisories) {
    summary.set(advisory.severity, (summary.get(advisory.severity) ?? 0) + 1);
  }
  return Array.from(summary.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([severity, count]) => `${severity}:${count}`)
    .join(" ");
}

const advisories = flattenAudit(runAudit());

if (WRITE_MODE) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: "2026-07-01",
        tool: "bun audit --json",
        scope:
          "Known dependency advisories present before the Preview Design annotation release gate.",
        advisories,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Wrote bun audit baseline: ${advisories.length} advisories (${severitySummary(advisories)})`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.advisories)) {
  throw new Error(`Invalid audit baseline: ${BASELINE_PATH}`);
}

const known = new Set(baseline.advisories.map((advisory) => advisory.key));
const current = new Set(advisories.map((advisory) => advisory.key));
const newAdvisories = advisories.filter((advisory) => !known.has(advisory.key));
const resolvedAdvisories = baseline.advisories.filter((advisory) => !current.has(advisory.key));

if (newAdvisories.length > 0) {
  console.error(`bun audit found ${newAdvisories.length} advisory/advisories outside the baseline:`);
  for (const advisory of newAdvisories) {
    console.error(`- ${advisory.key} ${advisory.severity} ${advisory.title}`);
  }
  process.exit(1);
}

console.log(
  `bun audit baseline check passed: ${advisories.length} current advisories are baselined (${severitySummary(advisories)})`,
);
if (resolvedAdvisories.length > 0) {
  console.log(`${resolvedAdvisories.length} baseline advisory/advisories no longer appear in bun audit.`);
}
