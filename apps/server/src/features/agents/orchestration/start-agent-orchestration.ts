import { AgentEventType, type AgentEvent, type IProviderRegistry, type PermissionRequest } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { AgentService } from "../../../services/agent-service.js";
import type { CiWatcherService } from "../../../services/ci-watcher.js";
import { normalizeAgentProviderError } from "../../../services/provider-agent-error-normalize.js";
import type { GithubService } from "../../../services/github-service.js";
import type { NarrativeStore } from "../../../services/narrative-store.js";
import { sanitizePublicToolInput } from "../../../services/public-tool-input.js";
import type { ThreadService } from "../../../services/thread-service.js";
import type { ThreadRepo } from "../../../repositories/thread-repo.js";
import type { WorkspaceRepo } from "../../../repositories/workspace-repo.js";
import { publishParentProviderEvent } from "../events/provider-event-publication.js";
import { publishAgentPermissionEvents } from "../permissions/permission-publication.js";

interface AgentOrchestrationDependencies {
  agentService: AgentService;
  threadRepo: ThreadRepo;
  workspaceRepo: WorkspaceRepo;
  narrativeStore: NarrativeStore;
  threadService: ThreadService;
  githubService: GithubService;
  ciWatcherService: CiWatcherService;
  providerRegistry: IProviderRegistry;
  publishAgentEvent: (event: AgentEvent) => void;
  publishPermissionRequest: (request: PermissionRequest) => void;
  publishPermissionResolved: (payload: { requestId: string; decision: "allow" | "allow-session" | "deny" | "cancelled" }) => void;
  publishThreadStatus: (payload: { threadId: string; status: "completed" | "errored" }) => void;
  publishThreadPrLinked: (payload: { threadId: string; prNumber: number; prStatus: string }) => void;
}

/**
 * Start agent execution and publish each normalized provider event after its
 * synchronous internal pass; deferred replays do not publish duplicates.
 */
export function startAgentOrchestration({
  agentService,
  threadRepo,
  workspaceRepo,
  narrativeStore,
  threadService,
  githubService,
  ciWatcherService,
  providerRegistry,
  publishAgentEvent,
  publishPermissionRequest,
  publishPermissionResolved,
  publishThreadStatus,
  publishThreadPrLinked,
}: AgentOrchestrationDependencies): void {
  publishAgentPermissionEvents({
    providerRegistry,
    publishPermissionRequest,
    publishPermissionResolved,
  });

  agentService.init((event) => {
    let enrichedEvent = event;

    if (event.type === AgentEventType.TurnStarted) {
      const fileEffectTurnId = agentService.getCurrentFileEffectTurnId(event.threadId);
      if (fileEffectTurnId) enrichedEvent = { ...event, fileEffectTurnId };
    }

    // Prefer the SDK-provided parent ID for parallel subagents. The narrative
    // fallback is only authoritative when exactly one Agent remains active.
    if (event.type === AgentEventType.ToolUse && event.toolName !== "Agent") {
      if (!event.parentToolCallId) {
        const parentId = narrativeStore.getCurrentParentToolCallId(event.threadId);
        if (parentId) {
          enrichedEvent = { ...event, parentToolCallId: parentId };
        }
      }
    }

    if (
      (event.type === AgentEventType.Ended
        && agentService.shouldSuppressTurnEnded(event.threadId))
      || (event.type === AgentEventType.TurnComplete
        && agentService.shouldSuppressTurnComplete(event.threadId))
    ) {
      return;
    }

    if (event.type === AgentEventType.Error) {
      if (agentService.shouldSuppressTransientTurnError(event.threadId, event.error ?? "")) {
        return;
      }
      const thread = threadRepo.findById(event.threadId);
      const provider = typeof thread?.provider === "string" && thread.provider.length > 0
        ? thread.provider
        : "claude";
      enrichedEvent = {
        ...event,
        error: normalizeAgentProviderError(provider, event.error ?? ""),
      };
    }

    if (enrichedEvent.type === AgentEventType.ToolUse) {
      enrichedEvent = {
        ...enrichedEvent,
        toolInput: sanitizePublicToolInput(enrichedEvent.toolInput, enrichedEvent.toolName),
      };
    } else if (enrichedEvent.type === AgentEventType.ToolResult && enrichedEvent.toolInput) {
      enrichedEvent = {
        ...enrichedEvent,
        toolInput: sanitizePublicToolInput(enrichedEvent.toolInput),
      };
    }

    const publishedToParent = publishParentProviderEvent(event, enrichedEvent, {
      publishAgentEvent,
      updateThreadStatus: (threadId, status) => {
        threadRepo.updateStatus(threadId, status);
      },
      publishThreadStatus,
    });
    if (!publishedToParent || event.type !== AgentEventType.TurnComplete) return;

    const thread = threadRepo.findById(event.threadId);
    if (!thread) return;

    const isFeatureBranch = thread.branch !== "main" && thread.branch !== "master";
    const workspace = isFeatureBranch ? workspaceRepo.findById(thread.workspace_id) : null;
    if (!workspace) return;

    githubService.getBranchPr(thread.branch, workspace.path).then((pr) => {
      if (!pr) return;
      const stateChanged = thread.pr_number == null
        || thread.pr_status?.toLowerCase() !== pr.state.toLowerCase();
      if (stateChanged) {
        threadService.linkPr(thread.id, pr.number, pr.state);
        const prPayload = { threadId: thread.id, prNumber: pr.number, prStatus: pr.state };
        publishThreadPrLinked(prPayload);
      }
      const prState = pr.state.toLowerCase();
      if (prState !== "merged" && prState !== "closed") {
        ciWatcherService.watch(thread.id, pr.number, thread.branch, workspace.path);
      } else {
        ciWatcherService.unwatch(thread.id);
      }
    }).catch((error) => {
      // PR refresh is best effort and must not affect terminal event publication.
      logger.debug("PR lookup failed on turnComplete", {
        threadId: thread.id,
        branch: thread.branch,
        workspacePath: workspace.path,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
