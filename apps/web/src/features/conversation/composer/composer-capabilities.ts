import { supportsCodexUltraOrchestration } from "@mcode/contracts";
import type { ProviderCapability } from "@mcode/contracts";
import { isXhighEffortModel } from "@/lib/model-registry";

/** Stable IDs for capabilities that can be attached to the composer. */
export type ComposerCapabilityId = "plan" | "goal" | "orchestration";

/** Side effects dispatched when a slash command attaches a composer capability. */
export type ComposerCapabilityAction =
  | "attach-plan"
  | "attach-goal"
  | "attach-orchestration";

/** Provider-resolved capability metadata shared by every composer entry point. */
export interface ResolvedComposerCapability {
  /** Stable identity used for attachment state and icons. */
  id: ComposerCapabilityId;
  /** Provider-aware title shown in menus and attached chips. */
  label: "Plan" | "Goal" | "Ultra" | "Ultracode";
  /** Supporting text shown in the composer add menu. */
  description: string;
  /** Slash command name without the leading slash. */
  slashCommand: "plan" | "goal" | "ultra" | "ultracode";
  /** Composer action dispatched when the slash command is selected. */
  action: ComposerCapabilityAction;
}

/** Inputs used to resolve capabilities for the active provider and model. */
export interface ResolveComposerCapabilitiesOptions {
  /** Active provider ID. Undefined preserves provider-neutral Plan discovery. */
  providerId?: string;
  /** Active model ID used for model-specific orchestration support. */
  modelId?: string;
}

/** Resolves the review selector from a provider descriptor when one is available. */
export function supportsApprovalReview(capabilities: readonly ProviderCapability[]): boolean {
  return capabilities.some((capability) => (
    capability.name === "approval-review" && capability.support === "supported"
 ));
}

const PLAN_CAPABILITY: ResolvedComposerCapability = {
  id: "plan",
  label: "Plan",
  description: "Explore the work and propose a plan",
  slashCommand: "plan",
  action: "attach-plan",
};

const GOAL_CAPABILITY: ResolvedComposerCapability = {
  id: "goal",
  label: "Goal",
  description: "Set the objective for the next run",
  slashCommand: "goal",
  action: "attach-goal",
};

const ULTRA_CAPABILITY: ResolvedComposerCapability = {
  id: "orchestration",
  label: "Ultra",
  description: "Proactively delegate work to sub-agents",
  slashCommand: "ultra",
  action: "attach-orchestration",
};

const ULTRACODE_CAPABILITY: ResolvedComposerCapability = {
  id: "orchestration",
  label: "Ultracode",
  description: "Proactively delegate work to sub-agents",
  slashCommand: "ultracode",
  action: "attach-orchestration",
};

/**
 * Resolves the exact capabilities exposed by the plus menu, slash commands,
 * and attached-chip row for the selected provider and model.
 */
export function resolveComposerCapabilities({
  providerId,
  modelId,
}: ResolveComposerCapabilitiesOptions): ResolvedComposerCapability[] {
  const capabilities: ResolvedComposerCapability[] = [];

  if (providerId !== "copilot") {
    capabilities.push(PLAN_CAPABILITY);
  }
  if (providerId === "claude" || providerId === "codex") {
    capabilities.push(GOAL_CAPABILITY);
  }
  if (providerId === "codex" && modelId && supportsCodexUltraOrchestration(modelId)) {
    capabilities.push(ULTRA_CAPABILITY);
  } else if (providerId === "claude" && modelId && isXhighEffortModel(modelId)) {
    capabilities.push(ULTRACODE_CAPABILITY);
  }

  return capabilities;
}
