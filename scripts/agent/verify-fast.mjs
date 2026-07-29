#!/usr/bin/env bun
/** Compatibility entry point for the former fast gate. */
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

import { runVerification } from "./verify-tests.mjs";

/** @deprecated Explicit verification uses the changed-file gate through verify-tests.mjs. */
export const FAST_PHASES = [];

async function main() {
  console.warn("verify-fast is deprecated; running the changed-file gate.");
  const result = await runVerification({ gate: "changed" });
  process.exit(result.code);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
if (invokedDirectly) await main();
