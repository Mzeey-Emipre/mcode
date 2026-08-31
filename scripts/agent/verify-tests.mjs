#!/usr/bin/env bun
/** Runs Mcode's verification gates and records durable receipts for Stop hooks. */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ensureDependencies } from "./ensure-dependencies.mjs";
import {
  getChangedFiles,
  hasCodeChanges,
  isVerificationRelevant,
} from "../verification/changed-file-discovery.mjs";
import {
  DEFAULT_PHASES,
  FULL_TEST_PHASE,
  MAX_RELATED_ARG_BYTES,
  MAX_RELATED_FILES,
  SCRIPT_TEST_PHASE,
  buildPhases,
  selectTestPhases,
} from "../verification/phase-definitions.mjs";
import {
  DEFAULT_PHASE_TIMEOUT_MS,
  MAX_DISPLAYED_ARGV_CHARS,
  MAX_FAILURE_EXCERPT_CHARS,
  MAX_RETAINED_OUTPUT_BYTES,
  formatArgvDisplay,
  formatSafeReproduction,
  pathEntriesMatch,
  runPhase,
  runPhasesInParallel,
  runVerificationPhases,
  withBunPath,
} from "../verification/phase-runner.mjs";
import {
  MAX_RETAINED_RUNS,
  VERIFICATION_SCHEMA_VERSION,
  calculateVerificationIdentities,
  findReusableResult,
  inspectVerificationReceipt,
  runVerification,
} from "../verification/verification-coordinator.mjs";

export {
  DEFAULT_PHASES,
  DEFAULT_PHASE_TIMEOUT_MS,
  FULL_TEST_PHASE,
  MAX_DISPLAYED_ARGV_CHARS,
  MAX_FAILURE_EXCERPT_CHARS,
  MAX_RELATED_ARG_BYTES,
  MAX_RELATED_FILES,
  MAX_RETAINED_OUTPUT_BYTES,
  MAX_RETAINED_RUNS,
  SCRIPT_TEST_PHASE,
  VERIFICATION_SCHEMA_VERSION,
  buildPhases,
  calculateVerificationIdentities,
  findReusableResult,
  formatArgvDisplay,
  formatSafeReproduction,
  getChangedFiles,
  hasCodeChanges,
  inspectVerificationReceipt,
  isVerificationRelevant,
  pathEntriesMatch,
  runPhase,
  runPhasesInParallel,
  runVerification,
  runVerificationPhases,
  selectTestPhases,
  withBunPath,
};

async function main() {
  const gate = process.argv.includes("--full") ? "full" : "changed";
  if (process.argv.includes("--check-receipt")) {
    const result = inspectVerificationReceipt({ gate, printer: () => {} });
    const print = result.code === 0 ? console.log : console.error;
    print(result.reason);
    process.exit(result.code);
  }
  ensureDependencies();
  const result = await runVerification({ gate });
  process.exit(result.code);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
