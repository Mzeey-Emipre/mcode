/**
 * WebSocket RPC method router.
 * Parses incoming messages, validates params against WS_METHODS Zod schemas,
 * dispatches to the appropriate service, validates results, and returns responses.
 */

import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  WS_METHODS,
  WebSocketRequestSchema,
  type WebSocketRequest,
  type WebSocketResponse,
  type WsMethodName,
  type IProviderRegistry,
  type ProviderUsageInfo,
  getExtension,
} from "@mcode/contracts";
import { logger, validateBranchName } from "@mcode/shared";
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
import type { ToolCallRecordRepo } from "../repositories/tool-call-record-repo";
import type { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import type { TaskRepo } from "../repositories/task-repo";
import type { SnapshotService } from "../services/snapshot-service";
import type { SettingsService } from "../services/settings-service";
import type { GitWatcherService } from "../services/git-watcher-service";
import type { MemoryPressureService } from "../services/memory-pressure-service";
import type { PrDraftService } from "../services/pr-draft-service";
import type { CiWatcherService } from "../services/ci-watcher";
import type { ThreadRepo } from "../repositories/thread-repo";
import type { WorkspaceRepo } from "../repositories/workspace-repo";
import { broadcast } from "./push";

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
  toolCallRecordRepo: ToolCallRecordRepo;
  turnSnapshotRepo: TurnSnapshotRepo;
  snapshotService: SnapshotService;
  settingsService: SettingsService;
  /** Watcher service for tracking per-workspace HEAD file changes. */
  gitWatcherService: GitWatcherService;
  /** Manages lifecycle-aware memory pressure (idle timers, SQLite cache, GC). */
  memoryPressureService: MemoryPressureService;
  taskRepo: TaskRepo;
  /** Registry of AI provider adapters for model discovery. */
  providerRegistry: IProviderRegistry;
  /** Generates AI-powered PR draft titles and bodies. */
  prDraftService: PrDraftService;
  /** CI check watcher for adaptive polling and manual refresh. */
  ciWatcherService: CiWatcherService;
  /** Thread repository for resolving worktree paths in git operations. */
  threadRepo: ThreadRepo;
  /** Workspace repository for resolving repo paths in git operations. */
  workspaceRepo: WorkspaceRepo;
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

  const methodDef = WS_METHODS()[request.method as WsMethodName];
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
    case "workspace.create": {
      const workspace = deps.workspaceService.create(params.name, params.path);
      try {
        deps.gitWatcherService.watchWorkspace(workspace.id, workspace.path);
      } catch (err) {
        logger.warn("Failed to start branch watcher for workspace", {
          workspaceId: workspace.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return workspace;
    }
    case "workspace.delete": {
      const result = deps.workspaceService.delete(params.id);
      deps.gitWatcherService.unwatchWorkspace(params.id);
      return result;
    }

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
    case "thread.delete": {
      deps.ciWatcherService.unwatch(params.threadId);
      return deps.threadService.delete(
        params.threadId,
        params.cleanupWorktree,
      );
    }
    case "thread.updateTitle":
      return deps.threadService.updateTitle(
        params.threadId,
        params.title,
      );
    case "thread.updateSettings":
      return deps.threadService.updateSettings(params.threadId, {
        reasoning_level: params.reasoningLevel,
        interaction_mode: params.interactionMode,
        permission_mode: params.permissionMode,
      });
    case "thread.markViewed":
      deps.threadService.markViewed(params.threadId);
      return;
    case "thread.syncPrs": {
      const threads = deps.threadService.list(params.workspaceId);
      /** Returns true if the thread has no linked PR, missing status, or a non-terminal PR state. */
      const needsPrCheck = (t: { pr_number: number | null; pr_status: string | null }) => {
        if (t.pr_number == null || t.pr_status == null) return true;
        const s = t.pr_status.toLowerCase();
        return s !== "merged" && s !== "closed";
      };
      const needsCheck = threads.filter(needsPrCheck);
      if (needsCheck.length === 0) return [];
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) return [];
      const results: Array<{ threadId: string; prNumber: number; prStatus: string }> = [];
      await Promise.allSettled(
        needsCheck.map(async (t) => {
          const pr = await deps.githubService.getBranchPr(t.branch, workspace.path);
          if (pr) {
            const numberChanged = t.pr_number !== pr.number;
            const statusChanged = t.pr_status?.toLowerCase() !== pr.state.toLowerCase();
            if (numberChanged || statusChanged) {
              deps.threadService.linkPr(t.id, pr.number, pr.state);
              results.push({ threadId: t.id, prNumber: pr.number, prStatus: pr.state });
            }
            // Start CI watching if PR is not in terminal state
            const prState = pr.state.toLowerCase();
            if (prState !== "merged" && prState !== "closed") {
              deps.ciWatcherService.watch(t.id, pr.number, workspace.path);
            } else {
              deps.ciWatcherService.unwatch(t.id);
            }
          }
        }),
      );
      return results;
    }

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
    case "git.log": {
      let repoPath: string | undefined;
      if (params.threadId) {
        const t = deps.threadRepo.findById(params.threadId);
        const ws = t ? deps.workspaceRepo.findById(t.workspace_id) : null;
        if (t && ws) {
          repoPath = deps.gitService.resolveWorkingDir(ws.path, t.mode, t.worktree_path);
        }
      }
      return deps.gitService.log(params.workspaceId, params.branch, params.limit, params.baseBranch, repoPath);
    }
    case "git.commitDiff":
      return deps.gitService.commitDiff(params.workspaceId, params.sha, params.filePath, params.maxLines);
    case "git.commitFiles":
      return deps.gitService.commitFiles(params.workspaceId, params.sha);

    // Agent
    case "agent.send":
      await deps.agentService.sendMessage(
        params.threadId,
        params.content,
        params.permissionMode ?? "default",
        params.model,
        params.attachments,
        params.reasoningLevel,
        params.provider,
        params.interactionMode,
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
        params.reasoningLevel,
        params.provider,
        params.interactionMode,
        params.parentThreadId,
        params.forkedFromMessageId,
      );
    case "agent.stop":
      await deps.agentService.stopSession(params.threadId);
      return;
    case "agent.activeCount":
      return deps.agentService.activeCount();
    case "agent.answerQuestions":
      await deps.agentService.answerQuestions(
        params.threadId,
        params.answers,
        params.permissionMode ?? "default",
        params.reasoningLevel,
      );
      return;

    // Messages
    case "message.list":
      return deps.messageRepo.listByThread(
        params.threadId,
        params.limit,
        params.before,
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
    case "github.checkStatus": {
      const entry = deps.ciWatcherService.getEntry(params.threadId);
      if (!entry) {
        return { aggregate: "no_checks" as const, runs: [], fetchedAt: Date.now() };
      }
      const checks = await deps.githubService.getCheckRuns(entry.prNumber, entry.repoPath);
      entry.cache = checks;
      return checks;
    }

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
      await deps.terminalService.kill(params.ptyId);
      return;
    case "terminal.killByThread":
      await deps.terminalService.killByThread(params.threadId);
      return;

    // Tool Call Records
    case "toolCallRecord.list":
      return deps.toolCallRecordRepo.listByMessage(params.messageId);
    case "toolCallRecord.listByParent":
      return deps.toolCallRecordRepo.listByParent(params.parentToolCallId);

    // Thread tasks
    case "thread.getTasks":
      return deps.taskRepo.get(params.threadId);

    // Snapshots
    case "snapshot.getDiff": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      let snapshotCwd: string;
      if (snapshot.worktree_path) {
        snapshotCwd = snapshot.worktree_path;
      } else {
        const snapshotThread = deps.threadService.findById(snapshot.thread_id);
        if (!snapshotThread) throw new Error(`Thread not found for snapshot: ${snapshot.thread_id}`);
        const ws = deps.workspaceService.findById(snapshotThread.workspace_id);
        if (!ws) throw new Error(`Workspace not found: ${snapshotThread.workspace_id}`);
        snapshotCwd = deps.gitService.resolveWorkingDir(ws.path, snapshotThread.mode, snapshotThread.worktree_path);
      }
      return await deps.snapshotService.getDiff(snapshotCwd, snapshot.ref_before, snapshot.ref_after, params.filePath, params.maxLines);
    }
    case "snapshot.getDiffStats": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      let snapshotCwd: string;
      if (snapshot.worktree_path) {
        snapshotCwd = snapshot.worktree_path;
      } else {
        const snapshotThread = deps.threadService.findById(snapshot.thread_id);
        if (!snapshotThread) throw new Error(`Thread not found for snapshot: ${snapshot.thread_id}`);
        const ws = deps.workspaceService.findById(snapshotThread.workspace_id);
        if (!ws) throw new Error(`Workspace not found: ${snapshotThread.workspace_id}`);
        snapshotCwd = deps.gitService.resolveWorkingDir(ws.path, snapshotThread.mode, snapshotThread.worktree_path);
      }
      return await deps.snapshotService.getDiffStats(snapshotCwd, snapshot.ref_before, snapshot.ref_after);
    }
    case "snapshot.cleanup":
      return { removed: deps.turnSnapshotRepo.deleteExpired(
        parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10),
      ) };
    case "snapshot.listByThread":
      return deps.turnSnapshotRepo.listByThread(params.threadId);
    case "snapshot.getCumulativeDiff": {
      const snapshots = deps.turnSnapshotRepo.listByThread(params.threadId);
      if (snapshots.length === 0) return "";
      const first = snapshots[0];
      const last = snapshots[snapshots.length - 1];
      let cwd: string;
      if (first.worktree_path) {
        cwd = first.worktree_path;
      } else {
        const thread = deps.threadService.findById(params.threadId);
        if (!thread) throw new Error(`Thread not found: ${params.threadId}`);
        const ws = deps.workspaceService.findById(thread.workspace_id);
        if (!ws) throw new Error(`Workspace not found: ${thread.workspace_id}`);
        cwd = deps.gitService.resolveWorkingDir(ws.path, thread.mode, thread.worktree_path);
      }
      return await deps.snapshotService.getDiff(
        cwd,
        first.ref_before,
        last.ref_after,
        params.filePath,
        params.maxLines,
      );
    }

    // Clipboard (legacy JSON-RPC path -- binary upload preferred)
    case "clipboard.saveFile": {
      if (!params.data) {
        throw new Error("clipboard.saveFile via JSON-RPC requires the data field; use binary upload instead");
      }
      const buffer = Buffer.from(params.data, "base64");
      const id = randomUUID();
      const ext = getExtension(params.fileName);
      const suffix = ext ? `.${ext}` : "";
      const tempDir = join(tmpdir(), "mcode-attachments");
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${id}${suffix}`);
      await writeFile(tempPath, buffer);
      return {
        id,
        name: params.fileName,
        mimeType: params.mimeType,
        sizeBytes: buffer.byteLength,
        sourcePath: tempPath,
      };
    }

    // Settings
    case "settings.get":
      return deps.settingsService.get();
    case "settings.update":
      return deps.settingsService.update(params);

    // Provider
    case "provider.listModels": {
      const provider = deps.providerRegistry.resolve(params.providerId);
      if (!provider.listModels) {
        throw new Error(`Provider "${params.providerId}" does not support model listing`);
      }
      return provider.listModels();
    }
    case "provider.getUsage": {
      const provider = deps.providerRegistry.resolve(params.providerId);
      if (!provider.getUsage) {
        return { providerId: provider.id, quotaCategories: [] } satisfies ProviderUsageInfo;
      }
      return provider.getUsage();
    }

    // Memory pressure
    case "memory.setBackground":
      if (params.background) {
        deps.memoryPressureService.markBackground();
      } else {
        deps.memoryPressureService.markForeground();
      }
      return;

    // Git push
    case "git.push": {
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) throw new Error(`Workspace ${params.workspaceId} not found`);
      await deps.gitService.push(workspace.path, params.branch);
      return { success: true };
    }

    // GitHub PR draft and creation
    case "github.generatePrDraft":
      return await deps.prDraftService.generateDraft(
        params.workspaceId,
        params.threadId,
        params.baseBranch,
      );

    case "github.createPr": {
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) throw new Error(`Workspace ${params.workspaceId} not found`);

      const thread = deps.threadService.findById(params.threadId);
      if (!thread) throw new Error(`Thread ${params.threadId} not found`);
      if (thread.workspace_id !== params.workspaceId) {
        throw new Error(
          `Thread ${params.threadId} does not belong to workspace ${params.workspaceId}`,
        );
      }

      const repoPath = deps.gitService.resolveWorkingDir(
        workspace.path,
        thread.mode,
        thread.worktree_path,
      );
      const branch = thread.branch;
      if (!branch) throw new Error(`Missing branch for thread ${params.threadId}`);
      validateBranchName(branch);

      // Silent auto-push (no-op if already up to date)
      try {
        await deps.gitService.push(repoPath, branch);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to push branch "${branch}" to remote. Check push permissions. Details: ${detail}`,
        );
      }

      // Create PR via gh CLI
      const result = await deps.githubService.createPr({
        cwd: repoPath,
        title: params.title,
        body: params.body,
        baseBranch: params.baseBranch,
        isDraft: params.isDraft,
      });

      // Link PR to thread in DB and broadcast
      deps.threadService.linkPr(params.threadId, result.number, "OPEN");
      broadcast("thread.prLinked", {
        threadId: params.threadId,
        prNumber: result.number,
        prStatus: "OPEN",
      });

      // Start watching CI checks for the newly created PR
      deps.ciWatcherService.watch(params.threadId, result.number, repoPath);

      return result;
    }

    // App
    case "app.version":
      return process.env.MCODE_VERSION ?? "0.0.1";

    default:
      throw new Error(`Unhandled method: ${method}`);
  }
}
