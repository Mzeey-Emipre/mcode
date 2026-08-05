import {
  runBrowserConformanceScenarioCore,
  type BrowserConformanceExecutionFailure,
} from "./executor.js";
import { normalizeBrowserConformanceRun } from "./normalize.js";
import {
  createBrowserConformanceReplayBundle,
  writeBrowserConformanceReplayBundle,
} from "./replay.js";
import type {
  BrowserConformanceNormalizedRun,
  BrowserConformanceScenario,
  BrowserConformanceSubject,
} from "./model.js";

/** Inputs controlling replay capture around a test-library scenario run. */
export interface BrowserConformanceReplayRunnerOptions {
  readonly workspaceRoot: string;
  readonly fileName?: string;
  readonly failingInvariant: string;
  readonly injectedFault?: { readonly kind: string };
}

/** Runs one scenario through the shared timeline and writes bounded replay evidence on failure. */
export async function runBrowserConformanceScenarioWithReplay(
  scenario: BrowserConformanceScenario,
  subject: BrowserConformanceSubject,
  options: BrowserConformanceReplayRunnerOptions,
): Promise<BrowserConformanceNormalizedRun> {
  return runBrowserConformanceScenarioCore(scenario, subject, {
    onFailure: async (failure) => {
      await captureReplay(scenario, failure, options);
    },
  });
}

async function captureReplay(
  scenario: BrowserConformanceScenario,
  failure: BrowserConformanceExecutionFailure,
  options: BrowserConformanceReplayRunnerOptions,
): Promise<void> {
  const run = failure.run ?? normalizeBrowserConformanceRun({
    outcome: {
      status: "failed",
      effect: "none",
      recovery: "inspect",
      errorCode: "CONFORMANCE_FAILURE",
      errorStage: failure.cleanup.ok ? "dispatch" : "cleanup",
    },
    finalState: { resources: failure.final },
  });
  await writeBrowserConformanceReplayBundle(
    createBrowserConformanceReplayBundle({
      scenario,
      run,
      cleanup: {
        ...scenario.cleanup,
        baseline: scenario.cleanup.baseline,
        final: failure.final,
        comparison: failure.cleanup,
      },
      failingInvariant: options.failingInvariant,
      ...(options.injectedFault ? { injectedFault: options.injectedFault } : {}),
    }),
    { workspaceRoot: options.workspaceRoot, fileName: options.fileName },
  );
}
