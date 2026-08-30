import type {
  TerminalProfileInUseData,
  WsMethodName,
} from "@mcode/contracts";
import type { WebSocket } from "ws";
import { ZodError } from "zod";
import { TerminalBackendError, type TerminalBackend } from "../backends/terminal-backend.js";
import type { TerminalProfileService } from "../profiles/terminal-profile-service.js";
import type { WorkspaceTerminalPreferencesService } from "../preferences/workspace-terminal-preferences-service.js";
import type { SettingsService } from "../../settings/settings-service.js";

type TerminalManagementMethod =
  | "terminal.profile.list"
  | "terminal.profile.create"
  | "terminal.profile.update"
  | "terminal.profile.delete"
  | "terminal.profile.setDefault"
  | "terminal.workspacePreferences.get"
  | "terminal.workspacePreferences.update"
  | "terminal.workspacePreferences.reset"
  | "terminal.preferences.reset"
  | "terminal.preferences.update";

type TerminalClassicMethod =
  | "terminal.capabilities"
  | "terminal.create"
  | "terminal.write"
  | "terminal.resize"
  | "terminal.kill"
  | "terminal.pause"
  | "terminal.resume"
  | "terminal.checkpoint"
  | "terminal.killByThread"
  | "terminal.reattach"
  | "terminal.listActive"
  | "terminal.hasChildren";

type TerminalRpcMethod = Exclude<
  Extract<WsMethodName, `terminal.${string}`>,
  "terminal.diagnostics.report" | "terminal.diagnostics.getBundle"
>;

/** Defines the services required to route validated Terminal RPC calls. */
export interface TerminalRouterDeps {
  terminalService: TerminalBackend;
  terminalProfileService: TerminalProfileService;
  workspaceTerminalPreferencesService: WorkspaceTerminalPreferencesService;
  settingsService: SettingsService;
}

type TerminalManagementHandlers = Record<
  TerminalManagementMethod,
  (deps: TerminalRouterDeps, params: any) => Promise<unknown> | unknown
>;

type TerminalClassicHandlers = Record<
  TerminalClassicMethod,
  (deps: TerminalRouterDeps, params: any) => Promise<unknown> | unknown
>;

const terminalManagementHandlers: TerminalManagementHandlers = {
  "terminal.profile.list": async (deps) => await deps.terminalProfileService.list(),
  "terminal.profile.create": async (deps, params) => await deps.terminalProfileService.create(params),
  "terminal.profile.update": async (deps, params) => await deps.terminalProfileService.update(params),
  "terminal.profile.delete": async (deps, params) => {
    await deps.terminalProfileService.delete(params.profileId);
    return { deleted: true };
  },
  "terminal.profile.setDefault": async (deps, params) => ({
    defaultProfileId: await deps.terminalProfileService.setDefault(params.profileId),
  }),
  "terminal.workspacePreferences.get": (deps, params) => {
    const preference = deps.workspaceTerminalPreferencesService.get(params.workspaceId);
    return {
      workspaceId: params.workspaceId,
      defaultProfileId: preference?.defaultProfileId ?? null,
    };
  },
  "terminal.workspacePreferences.update": async (deps, params) => ({
    workspaceId: params.workspaceId,
    defaultProfileId: await deps.terminalProfileService.setWorkspaceDefault(
      params.workspaceId,
      params.defaultProfileId,
    ),
  }),
  "terminal.workspacePreferences.reset": (deps, params) => {
    deps.terminalProfileService.resetWorkspaceDefault(params.workspaceId);
    return { reset: true };
  },
  "terminal.preferences.reset": (deps, params) => {
    if (params.workspaceId) {
      deps.workspaceTerminalPreferencesService.get(params.workspaceId);
    }
    deps.settingsService.resetTerminalPreferences();
    if (params.workspaceId) {
      deps.terminalProfileService.resetWorkspaceDefault(params.workspaceId);
    }
    return { reset: true };
  },
  "terminal.preferences.update": (deps, params) => {
    const terminal = deps.settingsService.updateTerminalPreferences(params);
    return {
      terminal: {
        presentation: terminal.presentation,
        behavior: terminal.behavior,
        accessibility: terminal.accessibility,
      },
    };
  },
};

const terminalClassicHandlers: TerminalClassicHandlers = {
  "terminal.capabilities": (deps) => deps.terminalService.capabilities(),
  "terminal.create": (deps, params) => deps.terminalService.create(params.threadId),
  "terminal.write": (deps, params) => {
    deps.terminalService.write(params.ptyId, params.data);
  },
  "terminal.resize": (deps, params) => {
    deps.terminalService.resize(params.ptyId, params.cols, params.rows);
  },
  "terminal.kill": async (deps, params) => await deps.terminalService.kill(params.ptyId),
  "terminal.pause": (deps, params) => {
    deps.terminalService.pause(params.ptyId);
  },
  "terminal.resume": (deps, params) => {
    deps.terminalService.resume(params.ptyId);
  },
  "terminal.checkpoint": (deps, params) =>
    deps.terminalService.checkpoint(params.ptyId, params.seq, params.data),
  "terminal.killByThread": async (deps, params) =>
    await deps.terminalService.killByThread(params.threadId),
  "terminal.reattach": (deps, params) =>
    deps.terminalService.reattach(params.ptyId, params.lastSeq, params.cold),
  "terminal.listActive": (deps) => deps.terminalService.listActiveSessions(),
  "terminal.hasChildren": (deps, params) => deps.terminalService.hasChildren(params.ptyId),
};

const terminalSettingsInvalidMethods = new Set<TerminalManagementMethod>([
  "terminal.profile.create",
  "terminal.profile.update",
  "terminal.profile.setDefault",
  "terminal.workspacePreferences.update",
  "terminal.preferences.reset",
  "terminal.preferences.update",
]);

const terminalUnavailableAsSettingsMethods = new Set<TerminalManagementMethod>([
  "terminal.profile.setDefault",
  "terminal.workspacePreferences.update",
]);

const terminalManagementErrorHandlers: Record<
  string,
  (method: TerminalManagementMethod, error: object, message: string) => never
> = {
  PROFILE_IN_USE: (_method, error, message) => {
    const references = (error as { references: TerminalProfileInUseData["references"] }).references;
    throw new TerminalBackendError("PROFILE_IN_USE", "NEW_SESSION", message, undefined, { references });
  },
  PROFILE_NOT_FOUND: (method, _error, message) => {
    const retry = method === "terminal.profile.delete" ? "SAFE_RETRY" : "NEW_SESSION";
    throw new TerminalBackendError("PROFILE_NOT_FOUND", retry, message);
  },
  PROFILE_UNAVAILABLE: (method, _error, message) => {
    const code = terminalUnavailableAsSettingsMethods.has(method)
      ? "SETTINGS_INVALID"
      : "PROFILE_UNAVAILABLE";
    throw new TerminalBackendError(code, "NEW_SESSION", message);
  },
  WORKSPACE_NOT_FOUND: (method, _error, message) => {
    const code = method === "terminal.preferences.reset" ? "SETTINGS_INVALID" : "WORKSPACE_NOT_FOUND";
    const retry = method === "terminal.workspacePreferences.reset" ? "SAFE_RETRY" : "NEW_SESSION";
    throw new TerminalBackendError(code, retry, message);
  },
  SETTINGS_WRITE_BLOCKED: (_method, _error, message) => {
    throw new TerminalBackendError("SETTINGS_WRITE_BLOCKED", "RESTART", message);
  },
};

/** Checks whether a method belongs to the Terminal RPC family. */
export function isTerminalRpcMethod(method: WsMethodName): method is TerminalRpcMethod {
  return method.startsWith("terminal.") && !method.startsWith("terminal.diagnostics.");
}

/** Routes validated Terminal RPC parameters to the Terminal feature. */
export async function routeTerminalRpc(
  method: WsMethodName,
  params: any,
  deps: TerminalRouterDeps,
  client: WebSocket | undefined,
): Promise<unknown> {
  if (method.startsWith("terminal.session.")) {
    if (!client) throw new Error("Terminal v1 client identity is unavailable");
    return deps.terminalService.routeV1(method, params, client);
  }
  if (isTerminalManagementMethod(method)) {
    return await routeTerminalManagement(method, params, deps);
  }
  if (isTerminalClassicMethod(method)) {
    return await terminalClassicHandlers[method](deps, params);
  }
  throw new Error(`Unsupported Terminal method: ${method}`);
}

function isTerminalManagementMethod(method: WsMethodName): method is TerminalManagementMethod {
  return Object.hasOwn(terminalManagementHandlers, method);
}

function isTerminalClassicMethod(method: WsMethodName): method is TerminalClassicMethod {
  return Object.hasOwn(terminalClassicHandlers, method);
}

async function routeTerminalManagement(
  method: TerminalManagementMethod,
  params: any,
  deps: TerminalRouterDeps,
): Promise<unknown> {
  try {
    return await terminalManagementHandlers[method](deps, params);
  } catch (error) {
    return mapTerminalManagementError(method, error);
  }
}

function mapTerminalManagementError(method: TerminalManagementMethod, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = terminalManagementErrorCode(error);
  const handler = code ? terminalManagementErrorHandlers[code] : undefined;
  if (handler && error && typeof error === "object") {
    return handler(method, error, message);
  }
  if (isZodValidationError(error) && terminalSettingsInvalidMethods.has(method)) {
    throw new TerminalBackendError("SETTINGS_INVALID", "NEW_SESSION", message);
  }
  throw error;
}

function terminalManagementErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isZodValidationError(error: unknown): boolean {
  return error instanceof ZodError || (
    !!error &&
    typeof error === "object" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}
