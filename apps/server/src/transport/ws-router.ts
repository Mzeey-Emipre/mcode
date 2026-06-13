/**
 * WebSocket RPC method router.
 * Parses incoming messages, validates params against WS_METHODS Zod schemas,
 * dispatches to the appropriate service, validates results, and returns responses.
 */

import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { WebSocket } from "ws";

import {
  WS_METHODS,
  WebSocketRequestSchema,
  type WebSocketRequest,
  type WebSocketResponse,
  type WsMethodName,
  type IProviderRegistry,
  type ProviderUsageInfo,
  getExtension,
  isSkillCatalogCapable,
} from "@mcode/contracts";
import { logger, validateBranchName } from "@mcode/shared";
import { discoverCopilotAgents } from "../providers/copilot/copilot-agent-discovery.js";
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
import type { NarrativeStore } from "../services/narrative-store";
import type { ThoughtSegmentRepo } from "../repositories/thought-segment-repo";
import type { HookExecutionRepo } from "../repositories/hook-execution-repo";
import type { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import type { TaskRepo } from "../repositories/task-repo";
import type { PlanQuestionAnswersRepo } from "../repositories/plan-question-answers-repo";
import type { PlanRepo } from "../repositories/plan-repo";
import type { SnapshotService } from "../services/snapshot-service";
import type { SettingsService } from "../services/settings-service";
import type { GitWatcherService } from "../services/git-watcher-service";
import type { MemoryPressureService } from "../services/memory-pressure-service";
import type { PrDraftService } from "../services/pr-draft-service";
import type { CiWatcherService } from "../services/ci-watcher";
import type { ThreadRepo } from "../repositories/thread-repo";
import type { WorkspaceRepo } from "../repositories/workspace-repo";
import type { WorkspaceEnricher } from "../services/workspace-enricher";
import type { FilesystemBrowser } from "../services/filesystem-browser";
import { broadcast, subscribeClientToThread, unsubscribeClientFromThread } from "./push";
import { getTransportPayloadValidator } from "./payload-validation.js";
import {
  ProviderCliMissingError,
  isProviderAvailabilityError,
} from "../services/provider-availability-errors.js";
import type { ProviderAvailabilityService } from "../services/provider-availability-service.js";
import type { ModelCacheService } from "../services/model-cache-service.js";
import type { DiffSummaryService } from "../services/diff-summary-service.js";
import type { HandoffStorage } from "../services/handoff/handoff-storage.js";
import { loadConversationPage } from "../services/conversation-page.js";

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
  thoughtSegmentRepo: ThoughtSegmentRepo;
  hookExecutionRepo: HookExecutionRepo;
  /** Single-source ordered narrative reader backing the `turn.load` RPC. */
  narrativeStore: NarrativeStore;
  turnSnapshotRepo: TurnSnapshotRepo;
  snapshotService: SnapshotService;
  settingsService: SettingsService;
  /** Watcher service for tracking per-workspace HEAD file changes. */
  gitWatcherService: GitWatcherService;
  /** Manages lifecycle-aware memory pressure (idle timers, SQLite cache, GC). */
  memoryPressureService: MemoryPressureService;
  taskRepo: TaskRepo;
  /** Repository for the plan-question wizard answered marker (sidecar table). */
  planQuestionAnswersRepo: PlanQuestionAnswersRepo;
  /** Repository for structured plan records. */
  planRepo: PlanRepo;
  /** Registry of AI provider adapters for model discovery. */
  providerRegistry: IProviderRegistry;
  /** Tracks per-provider enabled flag and CLI verification state. */
  providerAvailability: ProviderAvailabilityService;
  /** Stale-while-revalidate cache for provider model lists, backed by SQLite. */
  modelCacheService: ModelCacheService;
  /** Generates AI-powered PR draft titles and bodies. */
  prDraftService: PrDraftService;
  /** Reads handoff artifacts from the filesystem. */
  handoffStorage: HandoffStorage;
  /** CI check watcher for adaptive polling and manual refresh. */
  ciWatcherService: CiWatcherService;
  /** Thread repository for resolving worktree paths in git operations. */
  threadRepo: ThreadRepo;
  /** Workspace repository for resolving repo paths in git operations. */
  workspaceRepo: WorkspaceRepo;
  /** Enriches workspaces with git and thread count metadata for the project selector. */
  enricher: WorkspaceEnricher;
  /** Browses the host filesystem for the project-selector folder picker. */
  filesystemBrowser: FilesystemBrowser;
  /** Generates and persists AI-powered diff summaries for threads. */
  diffSummaryService: DiffSummaryService;
}

/**
 * Route an incoming WebSocket message to the appropriate service method.
 * Returns a WebSocketResponse with the result or error.
 */
export async function routeMessage(
  raw: string,
  deps: RouterDeps,
  context: { client?: WebSocket } = {},
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
      context,
    );

    getTransportPayloadValidator().validateRpcResult(
      request.method,
      result,
      methodDef.result,
    );

    return { id: request.id, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isProviderAvailabilityError(err)) {
      logger.info("Provider unavailable in RPC", { method: request.method, providerId: err.providerId, code: err.code });
      return {
        id: request.id,
        error: {
          code: err.code,
          message,
          data:
            err instanceof ProviderCliMissingError
              ? { providerId: err.providerId, configuredPath: err.configuredPath, resolvedPath: null }
              : { providerId: err.providerId },
        },
      };
    }
    logger.error("RPC handler error", { method: request.method, error: message });
    return { id: request.id, error: { code: "INTERNAL_ERROR", message } };
  }
}

/**
 * Resolve a thread's working directory (worktree path or workspace root) for the
 * git working-tree/branch Review views, so a thread reads its own checkout. Returns
 * undefined when no thread is given (threadless → the service falls back to the
 * workspace root) or when the thread/workspace can't be found.
 */
function resolveThreadRepoPath(deps: RouterDeps, threadId?: string): string | undefined {
  if (!threadId) return undefined;
  const thread = deps.threadRepo.findById(threadId);
  const ws = thread ? deps.workspaceRepo.findById(thread.workspace_id) : null;
  if (!thread || !ws) return undefined;
  return deps.gitService.resolveWorkingDir(ws.path, thread.mode, thread.worktree_path);
}

/** Dispatch a validated method call to the appropriate service. */
async function dispatch(
  method: WsMethodName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  deps: RouterDeps,
  context: { client?: WebSocket },
): Promise<unknown> {
  switch (method) {
    case "push.subscribeThread":
      if (context.client) {
        subscribeClientToThread(context.client, params.threadId);
      }
      return;
    case "push.unsubscribeThread":
      if (context.client) {
        unsubscribeClientFromThread(context.client, params.threadId);
      }
      return;

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
      if (result) {
        deps.gitWatcherService.unwatchWorkspace(params.id);
        broadcast("workspace.orderChanged", {});
      }
      return result;
    }
    case "workspace.forceDelete": {
      const result = deps.workspaceService.forceDelete(params.id);
      if (result) {
        deps.gitWatcherService.unwatchWorkspace(params.id);
        broadcast("workspace.deleted", { workspaceId: params.id });
        broadcast("workspace.orderChanged", {});
      }
      return result;
    }
    case "workspace.pin":
      deps.workspaceRepo.setPinned(params.id, params.pinned);
      return { ok: true as const };
    case "workspace.removeRecent":
      deps.workspaceRepo.removeRecent(params.id);
      return { ok: true as const };
    case "workspace.touchLastOpened":
      deps.workspaceRepo.touchLastOpened(params.id);
      return { ok: true as const };
    case "workspace.reorder": {
      deps.workspaceService.reorder(params.id, params.newIndex);
      broadcast("workspace.orderChanged", {});
      return { ok: true as const };
    }
    case "workspace.enrich": {
      const wsItems = (params.ids as string[])
        .map((id: string) => deps.workspaceRepo.findById(id))
        .filter((w): w is NonNullable<typeof w> => w !== null && w !== undefined)
        .map((w) => ({ id: w.id, path: w.path }));
      return { items: await deps.enricher.enrich(wsItems) };
    }
    case "filesystem.browse":
      return deps.filesystemBrowser.browse(params.path);

    // Thread
    case "thread.list": {
      deps.workspaceService.touch(params.workspaceId);
      // Re-detect git status for non-git workspaces (catches `git init` within a session)
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (ws && !ws.is_git_repo) {
        deps.gitWatcherService.retryWatch(ws.id, ws.path);
      }
      return deps.threadService.list(params.workspaceId);
    }
    case "thread.recent":
      return deps.threadService.listRecent(params.limit);
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
        copilot_agent: params.copilotAgent,
        context_window_mode: params.contextWindow,
        thinking: params.thinking,
        codex_fast_mode: params.codexFastMode,
        default_open_in_app: params.defaultOpenInApp,
      });
    case "thread.markViewed":
      deps.threadService.markViewed(params.threadId);
      return;
    case "thread.search":
      return deps.threadService.search({
        query: params.query,
        filters: params.filters,
        sort: params.sort,
        limit: params.limit,
      });
    case "thread.syncPrs": {
      const syncWs = deps.workspaceService.findById(params.workspaceId);
      if (!syncWs?.is_git_repo) return [];
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
            // Start CI watching if PR is not in terminal state.
            // Unwatch first when the PR number changed so the watcher targets the new PR.
            const prState = pr.state.toLowerCase();
            if (prState !== "merged" && prState !== "closed") {
              if (numberChanged) deps.ciWatcherService.unwatch(t.id);
              deps.ciWatcherService.watch(t.id, pr.number, t.branch, workspace.path);
            } else {
              deps.ciWatcherService.unwatch(t.id);
            }
          }
        }),
      );
      return results;
    }

    // Git
    case "git.listBranches": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.listBranches(params.workspaceId);
    }
    case "git.currentBranch": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return null;
      return deps.gitService.getCurrentBranch(params.workspaceId);
    }
    case "git.checkout": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return;
      deps.gitService.checkout(params.workspaceId, params.branch);
      return;
    }
    case "git.listWorktrees": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.listWorktrees(params.workspaceId);
    }
    case "git.fetchBranch": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return;
      deps.gitService.fetchBranch(
        params.workspaceId,
        params.branch,
        params.prNumber,
      );
      return;
    }
    case "git.log": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      let repoPath: string | undefined;
      if (params.threadId) {
        const t = deps.threadRepo.findById(params.threadId);
        const wsForThread = t ? deps.workspaceRepo.findById(t.workspace_id) : null;
        if (t && wsForThread) {
          repoPath = deps.gitService.resolveWorkingDir(wsForThread.path, t.mode, t.worktree_path);
        }
      }
      return deps.gitService.log(
        params.workspaceId,
        params.branch,
        params.limit,
        params.baseBranch,
        repoPath,
        params.skip,
        params.includeStats,
      );
    }
    case "git.commitDiff": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return "";
      return deps.gitService.commitDiff(params.workspaceId, params.sha, params.filePath, params.maxLines);
    }
    case "git.commitFiles": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.commitFiles(params.workspaceId, params.sha);
    }
    case "git.workingTreeFiles": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.workingTreeFiles(params.workspaceId, params.staged, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.workingTreeDiff": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return "";
      return deps.gitService.workingTreeDiff(params.workspaceId, params.staged, params.filePath, params.maxLines, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.branchFiles": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.branchFiles(params.workspaceId, params.base, params.target, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.branchDiff": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return "";
      return deps.gitService.branchDiff(params.workspaceId, params.base, params.target, params.filePath, params.maxLines, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.branchComparison": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return { base: null, target: null, refs: [], isUnborn: false };
      return deps.gitService.resolveBranchComparison(params.workspaceId, resolveThreadRepoPath(deps, params.threadId));
    }

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
        params.maxBudgetUsd,
        params.maxTurns,
        params.copilotAgent,
        params.contextWindow,
        params.thinking,
        params.codexFastMode,
        undefined,
        undefined,
        params.replyToMessageId,
        params.quotedText,
        params.displayContent,
        params.planAction,
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
        params.maxBudgetUsd,
        params.maxTurns,
        params.copilotAgent,
        params.contextWindow,
        params.thinking,
        params.codexFastMode,
        params.displayContent,
      );
    case "agent.stop":
      await deps.agentService.stopSession(params.threadId);
      return;
    case "agent.activeCount":
      return deps.agentService.activeCount();
    case "agent.listRunning":
      return deps.agentService.activeThreadIds();
    case "agent.answerQuestions":
      await deps.agentService.answerQuestions(
        params.threadId,
        params.answers,
        params.permissionMode ?? "default",
        params.reasoningLevel,
        params.contextWindow,
        params.thinking,
      );
      return;
    case "agent.dismissPlanQuestions":
      deps.agentService.dismissPlanQuestions(params.threadId);
      return;
    case "plan.updateStatus":
      deps.planRepo.updateStatus(params.planId, params.status);
      return;
    case "plan.list":
      return deps.planRepo.listByThread(params.threadId);

    // Messages
    case "message.list": {
      const paginated = deps.messageRepo.listByThread(
        params.threadId,
        params.limit,
        params.before,
      );
      return {
        ...paginated,
        answeredPlanMessageIds:
          deps.planQuestionAnswersRepo.listAnsweredForThread(params.threadId),
      };
    }
    case "conversation.page":
      return loadConversationPage(deps, {
        threadId: params.threadId,
        limit: params.limit,
        before: params.before,
      });

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
      // 15s window: matches the active-set polling cadence so a fresh tick result
      // satisfies most reads without spawning a redundant `gh pr checks` subprocess.
      // `force: true` (used by the manual refresh button) bypasses this guard.
      const STALENESS_MS = 15_000;
      if (!params.force) {
        const fresh = deps.ciWatcherService.getFreshCache(params.threadId, STALENESS_MS);
        if (fresh) return fresh;
      }

      let entry = deps.ciWatcherService.getEntry(params.threadId);
      if (!entry) {
        // Bootstrap: thread may not be in the watcher yet (e.g. connect race before syncThreadPrs).
        // Look up the stored PR number and start watching so future polls work automatically.
        const thread = deps.threadRepo.findById(params.threadId);
        const prState = thread?.pr_status?.toLowerCase();
        const isTerminal = prState === "merged" || prState === "closed";
        if (thread?.pr_number) {
          const workspace = deps.workspaceRepo.findById(thread.workspace_id);
          if (workspace) {
            if (isTerminal) {
              // Terminal PR: one-shot fetch without registering in the watcher — no need to poll.
              return deps.githubService.getCheckRuns(thread.branch, workspace.path);
            }
            // skipInitialFetch: checkStatus will fetch and broadcast below, no need for a second subprocess.
            deps.ciWatcherService.watch(params.threadId, thread.pr_number, thread.branch, workspace.path, { skipInitialFetch: true });
            entry = deps.ciWatcherService.getEntry(params.threadId);
          }
        }
      }
      if (!entry) {
        return { aggregate: "no_checks" as const, runs: [], fetchedAt: Date.now() };
      }
      const checks = await deps.githubService.getCheckRuns(entry.branch, entry.repoPath);
      deps.ciWatcherService.refresh(params.threadId, checks);
      return checks;
    }

    // Config
    case "config.discover":
      return deps.configService.discover(params.workspacePath);

    // Skills
    case "skill.list": {
      let nativeSkills;
      if (params.providerId === "codex") {
        const provider = deps.providerRegistry.resolve("codex");
        nativeSkills = isSkillCatalogCapable(provider)
          ? await provider.listSkills(params.cwd)
          : undefined;
      }
      return deps.skillService.list(params.cwd, params.providerId, nativeSkills);
    }
    case "skill.diagnose":
      return deps.skillService.diagnose(params.cwd);

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
    case "terminal.pause": {
      const { ptyId } = params as { ptyId: string };
      deps.terminalService.pause(ptyId);
      return;
    }
    case "terminal.resume": {
      const { ptyId } = params as { ptyId: string };
      deps.terminalService.resume(ptyId);
      return;
    }
    case "terminal.killByThread":
      await deps.terminalService.killByThread(params.threadId);
      return;
    case "terminal.reattach":
      return deps.terminalService.reattach(params.ptyId, params.lastSeq);
    case "terminal.listActive":
      return deps.terminalService.listActiveSessions();
    case "terminal.hasChildren":
      return deps.terminalService.hasChildren(params.ptyId);

    // Tool Call Records
    case "toolCallRecord.list":
      return deps.toolCallRecordRepo.listByMessage(params.messageId);
    case "toolCallRecord.listByParent":
      return deps.toolCallRecordRepo.listByParent(params.parentToolCallId);
    case "turn.load":
      return deps.narrativeStore.load(params.threadId, params.range);
    case "narrative.list":
      return {
        tools: deps.toolCallRecordRepo.listByMessage(params.messageId),
        thoughts: deps.thoughtSegmentRepo.listByMessage(params.messageId),
        hooks: deps.hookExecutionRepo.listByMessage(params.messageId),
      };

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
      deps.providerAvailability.assertEnabled(params.providerId);
      // Routed through ModelCacheService so cached entries hydrate the response
      // synchronously while a background refresh keeps the cache fresh.
      return deps.modelCacheService.listModels(params.providerId);
    }
    case "provider.getUsage": {
      deps.providerAvailability.assertUsable(params.providerId);
      const provider = deps.providerRegistry.resolve(params.providerId);
      if (!provider.getUsage) {
        return { providerId: provider.id, quotaCategories: [] } satisfies ProviderUsageInfo;
      }
      return provider.getUsage();
    }
    case "providers.listAvailability": {
      return deps.providerAvailability.listAvailability();
    }
    case "provider.copilotAgents": {
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${params.workspaceId}`);
      return discoverCopilotAgents(workspace.path);
    }

    // Diff summaries
    case "diffSummary.get":
      return deps.diffSummaryService.get(params.threadId);
    case "diffSummary.generate": {
      const thread = deps.threadService.findById(params.threadId);
      if (!thread) throw new Error(`Thread not found: ${params.threadId}`);
      const ws = deps.workspaceService.findById(thread.workspace_id);
      if (!ws) throw new Error(`Workspace not found: ${thread.workspace_id}`);
      const cwd = deps.gitService.resolveWorkingDir(
        ws.path,
        thread.mode,
        thread.worktree_path,
      );
      // listByThread returns parsed TurnSnapshot[]; re-serialize files_changed
      // to the raw JSON string that ThreadDiffSource expects.
      const snapshots = deps.turnSnapshotRepo.listByThread(params.threadId).map((s) => ({
        ...s,
        files_changed: JSON.stringify(s.files_changed),
      }));
      return await deps.diffSummaryService.generateFromSnapshots(
        params.threadId,
        snapshots,
        cwd,
      );
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
      if (!workspace.is_git_repo) return;
      await deps.gitService.push(workspace.path, params.branch);
      // Fresh CI runs appear 3-15s after push. Schedule bumps so the UI surfaces
      // "pending" without waiting a full passive poll cycle.
      const threadIds = deps.ciWatcherService.findByWorkspaceBranch(
        (id) => deps.threadRepo.findById(id),
        params.workspaceId,
        params.branch,
      );
      for (const id of threadIds) {
        deps.ciWatcherService.scheduleBumpAfterPush(id);
      }
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

      // Replace any stale watcher (e.g. previous PR on this thread) before registering the new one.
      deps.ciWatcherService.unwatch(params.threadId);
      deps.ciWatcherService.watch(params.threadId, result.number, branch, repoPath);
      // PR creation implicitly pushes, so schedule the same post-push bump burst.
      deps.ciWatcherService.scheduleBumpAfterPush(params.threadId);

      return result;
    }

    // App
    case "app.version":
      return process.env.MCODE_VERSION ?? "0.0.1";

    // Permission
    case "permission.respond": {
      deps.agentService.respondToPermission(params.requestId, params.decision);
      // broadcast is handled by the provider's "permission_resolved" event → index.ts listener
      return;
    }
    case "permission.listPending":
      return deps.agentService.listPendingPermissions(params.threadId);

    case "handoff.regenerate":
      // v1 stub; live regeneration is deferred to a follow-on plan.
      return { status: "not-implemented" as const };

    case "handoff.readLatest":
      return deps.handoffStorage.readLatest(params.threadId);

    default:
      throw new Error(`Unhandled method: ${method}`);
  }
}
