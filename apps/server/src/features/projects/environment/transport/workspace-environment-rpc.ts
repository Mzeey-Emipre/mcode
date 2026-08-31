import type {
  WorkspaceEnvironmentActionListInput,
  WorkspaceEnvironmentActionSlotInput,
  WorkspaceEnvironmentAutomaticSetupContinueInput,
  WorkspaceEnvironmentAutomaticSetupGetInput,
  WorkspaceEnvironmentAutomaticSetupRetryInput,
  WorkspaceEnvironmentAutomaticSetupStopInput,
  WorkspaceEnvironmentAutomaticSetupTerminalInput,
  WorkspaceEnvironmentCommandApprovalClearInput,
  WorkspaceEnvironmentCommandApproveInput,
  WorkspaceEnvironmentQueuedTurnCancelInput,
  WorkspaceEnvironmentReadInput,
  WorkspaceEnvironmentSaveInput,
  WorkspaceEnvironmentSetupGetInput,
  WorkspaceEnvironmentSetupStartInput,
  WorkspaceEnvironmentStorageSetInput,
  WsMethodName,
} from "@mcode/contracts";
import type { WorkspaceService } from "../../lifecycle/workspace-service.js";
import type { ProjectActionService } from "../project-action-service.js";
import { WorkspaceEnvironmentServiceError } from "../workspace-environment-errors.js";
import type { WorkspaceEnvironmentService } from "../workspace-environment-service.js";

type WorkspaceEnvironmentRpcMethod = Extract<
  WsMethodName,
  `workspace.environment.${string}`
>;

type WorkspaceEnvironmentParamsByMethod = {
  "workspace.environment.read": WorkspaceEnvironmentReadInput;
  "workspace.environment.save": WorkspaceEnvironmentSaveInput;
  "workspace.environment.storage.set": WorkspaceEnvironmentStorageSetInput;
  "workspace.environment.command.approve": WorkspaceEnvironmentCommandApproveInput;
  "workspace.environment.command.clearApprovals": WorkspaceEnvironmentCommandApprovalClearInput;
  "workspace.environment.setup.start": WorkspaceEnvironmentSetupStartInput;
  "workspace.environment.setup.get": WorkspaceEnvironmentSetupGetInput;
  "workspace.environment.automaticSetup.get": WorkspaceEnvironmentAutomaticSetupGetInput;
  "workspace.environment.automaticSetup.continue": WorkspaceEnvironmentAutomaticSetupContinueInput;
  "workspace.environment.automaticSetup.cancelQueuedTurn": WorkspaceEnvironmentQueuedTurnCancelInput;
  "workspace.environment.automaticSetup.stop": WorkspaceEnvironmentAutomaticSetupStopInput;
  "workspace.environment.automaticSetup.retry": WorkspaceEnvironmentAutomaticSetupRetryInput;
  "workspace.environment.automaticSetup.openTerminal": WorkspaceEnvironmentAutomaticSetupTerminalInput;
  "workspace.environment.action.list": WorkspaceEnvironmentActionListInput;
  "workspace.environment.action.get": WorkspaceEnvironmentActionSlotInput;
  "workspace.environment.action.start": WorkspaceEnvironmentActionSlotInput;
  "workspace.environment.action.stop": WorkspaceEnvironmentActionSlotInput;
  "workspace.environment.action.restart": WorkspaceEnvironmentActionSlotInput;
};

/** Defines the services required to route validated Workspace Environment RPC calls. */
export interface WorkspaceEnvironmentRouterDeps {
  workspaceService: Pick<WorkspaceService, "findById">;
  workspaceEnvironmentService: WorkspaceEnvironmentService;
  projectActionService: ProjectActionService;
}

type WorkspaceEnvironmentHandlerMap = {
  [Method in WorkspaceEnvironmentRpcMethod]: (
    deps: WorkspaceEnvironmentRouterDeps,
    params: WorkspaceEnvironmentParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const workspaceEnvironmentHandlers: WorkspaceEnvironmentHandlerMap = {
  "workspace.environment.read": (deps, params) => {
    requireWorkspace(deps, params.workspaceId);
    return deps.workspaceEnvironmentService.read(params.workspaceId, params.threadId);
  },
  "workspace.environment.save": (deps, params) => {
    requireWorkspace(deps, params.workspaceId);
    return deps.workspaceEnvironmentService.save(params);
  },
  "workspace.environment.storage.set": (deps, params) => {
    requireWorkspace(deps, params.workspaceId);
    return deps.workspaceEnvironmentService.setStorageMode(params);
  },
  "workspace.environment.command.approve": (deps, params) =>
    deps.workspaceEnvironmentService.approveCommand(params),
  "workspace.environment.command.clearApprovals": (deps, params) => {
    requireWorkspace(deps, params.workspaceId);
    deps.workspaceEnvironmentService.clearApprovals(params.workspaceId);
  },
  "workspace.environment.setup.start": (deps, params) =>
    deps.workspaceEnvironmentService.startSetup(params),
  "workspace.environment.setup.get": (deps, params) =>
    deps.workspaceEnvironmentService.getSetupAttempt(params),
  "workspace.environment.automaticSetup.get": (deps, params) =>
    deps.workspaceEnvironmentService.getAutomaticSetup(params),
  "workspace.environment.automaticSetup.continue": (deps, params) =>
    deps.workspaceEnvironmentService.continueAutomaticSetup(params),
  "workspace.environment.automaticSetup.cancelQueuedTurn": (deps, params) =>
    deps.workspaceEnvironmentService.cancelQueuedAutomaticTurn(params),
  "workspace.environment.automaticSetup.stop": (deps, params) =>
    deps.workspaceEnvironmentService.stopAutomaticSetup(params),
  "workspace.environment.automaticSetup.retry": (deps, params) =>
    deps.workspaceEnvironmentService.retryAutomaticSetup(params),
  "workspace.environment.automaticSetup.openTerminal": (deps, params) =>
    deps.workspaceEnvironmentService.openAutomaticSetupTerminal(params),
  "workspace.environment.action.list": (deps, params) => ({
    runs: deps.projectActionService.list(params.threadId),
  }),
  "workspace.environment.action.get": (deps, params) => ({
    run: deps.projectActionService.get(params),
  }),
  "workspace.environment.action.start": (deps, params) =>
    deps.projectActionService.start(params),
  "workspace.environment.action.stop": async (deps, params) => ({
    run: await deps.projectActionService.stop(params),
  }),
  "workspace.environment.action.restart": (deps, params) =>
    deps.projectActionService.restart(params),
};

/** Checks whether a WebSocket method belongs to the Workspace Environment RPC family. */
export function isWorkspaceEnvironmentMethod(
  method: string,
): method is WorkspaceEnvironmentRpcMethod {
  return Object.hasOwn(workspaceEnvironmentHandlers, method);
}

/** Routes validated Workspace Environment parameters to their feature service method. */
export async function routeWorkspaceEnvironment<Method extends WorkspaceEnvironmentRpcMethod>(
  method: Method,
  params: WorkspaceEnvironmentParamsByMethod[Method],
  deps: WorkspaceEnvironmentRouterDeps,
): Promise<unknown> {
  return await workspaceEnvironmentHandlers[method](deps, params);
}

function requireWorkspace(
  deps: WorkspaceEnvironmentRouterDeps,
  workspaceId: string,
): void {
  if (deps.workspaceService.findById(workspaceId)) return;
  throw new WorkspaceEnvironmentServiceError(
    "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    `Workspace not found: ${workspaceId}`,
  );
}
