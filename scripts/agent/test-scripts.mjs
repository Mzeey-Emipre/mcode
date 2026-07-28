#!/usr/bin/env bun
/** Run maintained agent script tests one file at a time under Bun. */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const testDirectory = resolve(process.cwd(), "scripts", "agent", "__tests__");
const testFiles = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();

for (const file of testFiles) {
  const result = spawnSync(process.execPath, ["test", resolve(testDirectory, file)], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
