import type {
  WorkspaceEnvironmentAction,
  WorkspaceEnvironmentActionLaunchSnapshot,
} from "@mcode/contracts";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";
import type {
  WorkspaceEnvironmentCommandResolution,
  WorkspaceEnvironmentService,
} from "./workspace-environment-service.js";

/** Resolved Project Action state before terminal launch. */
export type ProjectActionResolution =
  | {
    readonly kind: "launch";
    readonly action: WorkspaceEnvironmentAction;
    readonly script: string;
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
  }
  | {
    readonly kind: "awaiting-approval";
    readonly action: WorkspaceEnvironmentAction;
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
  }
  | {
    readonly kind: "unavailable";
    readonly action: WorkspaceEnvironmentAction;
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
  }
  | {
    readonly kind: "configuration";
    readonly action: WorkspaceEnvironmentAction;
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
  };

/** Resolves one Action command and releases preparation before terminal launch. */
export async function resolveProjectAction(
  environment: Pick<WorkspaceEnvironmentService, "resolveActionCommand">,
  threadId: string,
  actionId: string,
): Promise<ProjectActionResolution> {
  const resolved = await environment.resolveActionCommand(threadId, actionId);
  const action = requireAction(resolved);
  if (resolved.kind !== "ready") return { kind: resolved.kind, action, snapshot: actionSnapshot(resolved.snapshot) };
  try {
    if (resolved.approval) return { kind: "awaiting-approval", action, snapshot: actionSnapshot(resolved.snapshot) };
    return { kind: "launch", action, script: resolved.script, snapshot: actionSnapshot(resolved.snapshot) };
  } finally {
    await resolved.command.close();
  }
}

/** Re-resolves once after a launch approval mismatch and returns only renewed approval work. */
export async function resolveApprovalAfterLaunchMismatch(
  environment: Pick<WorkspaceEnvironmentService, "resolveActionCommand">,
  threadId: string,
  actionId: string,
): Promise<Extract<ProjectActionResolution, { readonly kind: "awaiting-approval" }> | null> {
  const resolved = await environment.resolveActionCommand(threadId, actionId);
  if (resolved.kind !== "ready") return null;
  try {
    if (!resolved.approval || !resolved.action) return null;
    return {
      kind: "awaiting-approval",
      action: resolved.action,
      snapshot: actionSnapshot(resolved.snapshot),
    };
  } finally {
    await resolved.command.close();
  }
}

function requireAction(resolved: WorkspaceEnvironmentCommandResolution): WorkspaceEnvironmentAction {
  if (resolved.action) return resolved.action;
  throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND", "Project Action not found");
}

function actionSnapshot(
  snapshot: import("@mcode/contracts").WorkspaceEnvironmentSetupLaunchSnapshot,
): WorkspaceEnvironmentActionLaunchSnapshot {
  return {
    platform: snapshot.platform,
    script: snapshot.script,
    checkoutPath: snapshot.checkoutPath,
    terminal: snapshot.terminal,
    environmentNames: [],
    approval: snapshot.approval ?? null,
  };
}
