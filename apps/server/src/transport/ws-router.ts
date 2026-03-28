/**
 * WebSocket RPC method router.
 * Parses incoming messages, validates params against WS_METHODS Zod schemas,
 * dispatches to the appropriate service, validates results, and returns responses.
 */

import {
  WS_METHODS,
  WebSocketRequestSchema,
  type WebSocketRequest,
  type WebSocketResponse,
  type WsMethodName,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { WorkspaceService } from "../services/workspace-service";
import type { ThreadService } from "../services/thread-service";
import type { AgentService } from "../services/agent-service";
import type { GitService } from "../services/git-service";
import type { GithubService } from "../services/github-service";
import type { FileService } from "../services/file-service";
import type { ConfigService } from "../services/config-service";
import type { SkillService } from "../services/skill-service";
import type { TerminalService } from "../services/terminal-service";
import type { MessageRepo } from "../repositories/message-repo";

/** Service dependencies for the router. */
export interface RouterDeps {
  workspaceService: WorkspaceService;
  threadService: ThreadService;
  agentService: AgentService;
  gitService: GitService;
  githubService: GithubService;
  fileService: FileService;
  configService: ConfigService;
  skillService: SkillService;
  terminalService: TerminalService;
  messageRepo: MessageRepo;
}

/**
 * Route an incoming WebSocket message to the appropriate service method.
 * Returns a WebSocketResponse with the result or error.
 */
export async function routeMessage(
  raw: string,
  deps: RouterDeps,
): Promise<WebSocketResponse> {
  let request: WebSocketRequest;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const validated = WebSocketRequestSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        id: (parsed as { id?: string })?.id ?? "unknown",
        error: {
          code: "INVALID_REQUEST",
          message: validated.error.message,
        },
      };
    }
    request = validated.data;
  } catch {
    return {
      id: "unknown",
      error: { code: "PARSE_ERROR", message: "Invalid JSON" },
    };
  }

  const methodDef = WS_METHODS[request.method as WsMethodName];
  if (!methodDef) {
    return {
      id: request.id,
      error: {
        code: "METHOD_NOT_FOUND",
        message: `Unknown method: ${request.method}`,
      },
    };
  }

  // Validate params
  const paramsResult = methodDef.params.safeParse(request.params);
  if (!paramsResult.success) {
    return {
      id: request.id,
      error: {
        code: "INVALID_PARAMS",
        message: paramsResult.error.message,
      },
    };
  }

  try {
    const result = await dispatch(
      request.method as WsMethodName,
      paramsResult.data,
      deps,
    );

    // Validate result
    const resultValidation = methodDef.result.safeParse(result);
    if (!resultValidation.success) {
      logger.warn("Result validation failed", {
        method: request.method,
        error: resultValidation.error.message,
      });
      // Still return the result - schema drift should not block responses
    }

    return { id: request.id, result };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    logger.error("RPC handler error", {
      method: request.method,
      error: message,
    });
    return {
      id: request.id,
      error: { code: "INTERNAL_ERROR", message },
    };
  }
}

/** Dispatch a validated method call to the appropriate service. */
async function dispatch(
  method: WsMethodName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  deps: RouterDeps,
): Promise<unknown> {
  switch (method) {
    // Workspace
    case "workspace.list":
      return deps.workspaceService.list();
    case "workspace.create":
      return deps.workspaceService.create(params.name, params.path);
    case "workspace.delete":
      return deps.workspaceService.delete(params.id);

    // Thread
    case "thread.list":
      return deps.threadService.list(params.workspaceId);
    case "thread.create":
      return deps.threadService.create(
        params.workspaceId,
        params.title,
        params.mode,
        params.branch,
      );
    case "thread.delete":
      return deps.threadService.delete(
        params.threadId,
        params.cleanupWorktree,
      );
    case "thread.updateTitle":
      return deps.threadService.updateTitle(
        params.threadId,
        params.title,
      );
    case "thread.markViewed":
      deps.threadService.markViewed(params.threadId);
      return;

    // Git
    case "git.listBranches":
      return deps.gitService.listBranches(params.workspaceId);
    case "git.currentBranch":
      return deps.gitService.getCurrentBranch(params.workspaceId);
    case "git.checkout":
      deps.gitService.checkout(params.workspaceId, params.branch);
      return;
    case "git.listWorktrees":
      return deps.gitService.listWorktrees(params.workspaceId);
    case "git.fetchBranch":
      deps.gitService.fetchBranch(
        params.workspaceId,
        params.branch,
        params.prNumber,
      );
      return;

    // Agent
    case "agent.send":
      await deps.agentService.sendMessage(
        params.threadId,
        params.content,
        params.permissionMode ?? "default",
        params.model,
        params.attachments,
      );
      return;
    case "agent.createAndSend":
      return deps.agentService.createAndSend(
        params.workspaceId,
        params.content,
        params.model,
        params.permissionMode,
        params.mode,
        params.branch,
        params.existingWorktreePath,
        params.attachments,
      );
    case "agent.stop":
      deps.agentService.stopSession(params.threadId);
      return;
    case "agent.activeCount":
      return deps.agentService.activeCount();

    // Messages
    case "message.list":
      return deps.messageRepo.listByThread(
        params.threadId,
        params.limit,
      );

    // Files
    case "file.list":
      return deps.fileService.list(
        params.workspaceId,
        params.threadId,
      );
    case "file.read":
      return deps.fileService.read(
        params.workspaceId,
        params.relativePath,
        params.threadId,
      );

    // GitHub
    case "github.branchPr":
      return deps.githubService.getBranchPr(
        params.branch,
        params.cwd,
      );
    case "github.listOpenPrs":
      return deps.githubService.listOpenPrs(params.workspaceId);
    case "github.prByUrl":
      return deps.githubService.getPrByUrl(params.url);

    // Config
    case "config.discover":
      return deps.configService.discover(params.workspacePath);

    // Skills
    case "skill.list":
      return deps.skillService.list(params.cwd);

    // Terminal
    case "terminal.create":
      return deps.terminalService.create(params.threadId);
    case "terminal.write":
      deps.terminalService.write(params.ptyId, params.data);
      return;
    case "terminal.resize":
      deps.terminalService.resize(
        params.ptyId,
        params.cols,
        params.rows,
      );
      return;
    case "terminal.kill":
      deps.terminalService.kill(params.ptyId);
      return;
    case "terminal.killByThread":
      deps.terminalService.killByThread(params.threadId);
      return;

    // App
    case "app.version":
      return process.env.MCODE_VERSION ?? "0.0.1";

    default:
      throw new Error(`Unhandled method: ${method}`);
  }
}
