/** Hidden global switch that returns every provider to the legacy Browser tools. */
export const BROWSER_V2_LEGACY_ROLLBACK_ENV = "MCODE_BROWSER_V2_LEGACY_ROLLBACK";

/** Browser command surface selected for all provider sessions in one process. */
export type BrowserAutomationRolloutMode = "browser-v2" | "legacy";

/** Reason that selected the process-wide Browser command surface. */
export type BrowserAutomationRolloutReason =
  | "development"
  | "nightly"
  | "stable"
  | "legacy-rollback";

/** Content-free process-wide Browser rollout decision. */
export interface BrowserAutomationRolloutDecision {
  readonly mode: BrowserAutomationRolloutMode;
  readonly reason: BrowserAutomationRolloutReason;
  readonly rollbackActive: boolean;
}

/** Inputs used to resolve one provider-neutral Browser rollout decision. */
export interface BrowserAutomationRolloutInput {
  readonly version?: string;
  readonly nodeEnv?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Selects one Browser command surface for every provider in this process. */
export function resolveBrowserAutomationRollout(
  input: BrowserAutomationRolloutInput = {},
): BrowserAutomationRolloutDecision {
  const environment = input.environment ?? process.env;
  if (environment[BROWSER_V2_LEGACY_ROLLBACK_ENV] === "1") {
    return { mode: "legacy", reason: "legacy-rollback", rollbackActive: true };
  }

  const nodeEnv = input.nodeEnv ?? environment.NODE_ENV;
  if (nodeEnv !== "production") {
    return { mode: "browser-v2", reason: "development", rollbackActive: false };
  }

  const version = input.version ?? environment.MCODE_VERSION ?? "";
  if (/-nightly\./i.test(version)) {
    return { mode: "browser-v2", reason: "nightly", rollbackActive: false };
  }

  return { mode: "browser-v2", reason: "stable", rollbackActive: false };
}
