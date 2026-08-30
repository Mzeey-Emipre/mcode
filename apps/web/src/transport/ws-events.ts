import {
  ProviderCatalogChangeSchema,
  WS_CHANNELS,
  type ProviderAvailability,
  type Settings,
  type TurnFileEffectSummary,
} from "@mcode/contracts";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";
import { pushEmitter } from "./ws-transport";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { refreshTurnSnapshotsAfterPersist } from "@/lib/turn-snapshot-refresh";
import { useThreadStore } from "@/stores/threadStore";
import { getThreadRecord, patchThreadRecord } from "@/stores/thread-record";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useProviderCatalogStore } from "@/stores/providerCatalogStore";
import { usePlanStore } from "@/stores/planStore";
import { clearFileListCache } from "@/components/chat/useFileAutocomplete";
import { emitPtyData, emitPtyExit } from "@/features/terminal/adapters/pty-data-registry";
import { useThreadControlStore } from "@/stores/threadControlStore";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";

/** Unsubscribe handles for all push listeners. */
let unsubs: (() => void)[] = [];
let skillsInvalidationTimer: ReturnType<typeof setTimeout> | null = null;
const SKILLS_INVALIDATION_DEBOUNCE_MS = 100;

/** Encoder reused across all legacy JSON terminal.data frames. */
const _legacyEncoder = new TextEncoder();

/** Maximum PTY payload size accepted by the client (4 MB). */
const MAX_PTY_PAYLOAD_BYTES = 4 * 1024 * 1024;

type PtyDataDetail = { ptyId: string; payload: Uint8Array; seq: number };

/**
 * Estimates decoded byte length from a base64 string without allocating.
 */
function approxBase64DecodedBytes(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

function logOversizedPtyPayload(ptyId: string, byteLength: number, approximate = false): void {
  const measured = approximate ? `~${byteLength}` : byteLength;
  console.warn(
    `[ws-events] dropped oversized terminal.data payload (${measured} bytes) for PTY ${ptyId}`,
  );
}

function decodeBase64Payload(encoded: string): Uint8Array | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    console.warn("[ws-events] dropped terminal.data frame: invalid base64 payload");
    return null;
  }
}

function acceptPtyPayload(
  ptyId: string,
  payload: Uint8Array,
  approximate = false,
): Uint8Array | null {
  if (payload.byteLength <= MAX_PTY_PAYLOAD_BYTES) return payload;
  logOversizedPtyPayload(ptyId, payload.byteLength, approximate);
  return null;
}

function decodeBase64PtyPayload(ptyId: string, payload: string): Uint8Array | null {
  const approximateBytes = approxBase64DecodedBytes(payload);
  if (approximateBytes > MAX_PTY_PAYLOAD_BYTES) {
    logOversizedPtyPayload(ptyId, approximateBytes, true);
    return null;
  }
  const decoded = decodeBase64Payload(payload);
  return decoded ? acceptPtyPayload(ptyId, decoded) : null;
}

function decodeArrayPtyPayload(ptyId: string, payload: number[]): Uint8Array | null {
  if (payload.length > MAX_PTY_PAYLOAD_BYTES) {
    logOversizedPtyPayload(ptyId, payload.length);
    return null;
  }
  return new Uint8Array(payload);
}

function decodeIndexedPtyPayload(
  ptyId: string,
  payload: Record<string, number>,
): Uint8Array | null {
  return decodeArrayPtyPayload(ptyId, Object.values(payload));
}

function decodePtyPayload(data: Record<string, unknown>, ptyId: string): Uint8Array | null {
  const payload = data["payload"];
  if (payload instanceof Uint8Array) return acceptPtyPayload(ptyId, payload);
  if (typeof payload === "string" && data["encoding"] === "base64") {
    return decodeBase64PtyPayload(ptyId, payload);
  }
  if (Array.isArray(payload)) return decodeArrayPtyPayload(ptyId, payload as number[]);
  if (payload && typeof payload === "object") return decodeIndexedPtyPayload(ptyId, payload as Record<string, number>);
  return typeof data["data"] === "string" ? _legacyEncoder.encode(data["data"]) : null;
}

function handleTerminalData(data: unknown): void {
  const record = data as Record<string, unknown>;
  if (typeof record["ptyId"] !== "string") return;
  const ptyId = record["ptyId"];
  const sequence = typeof record["seq"] === "number" ? record["seq"] : 0;
  const payload = decodePtyPayload(record, ptyId);
  if (!payload) return;
  if (payload.byteLength > MAX_PTY_PAYLOAD_BYTES) {
    console.warn(
      `[ws-events] dropping oversized terminal.data payload (${payload.byteLength} bytes) for PTY ${ptyId}`,
    );
    return;
  }
  emitPtyData({ ptyId, payload, seq: sequence } satisfies PtyDataDetail);
}

/**
 * Wire up push channel listeners that forward server events to the
 * appropriate Zustand stores. Call once at app startup.
 *
 * Push channels handled:
 * - `agent.event` -- agent stream events forwarded to threadStore
 * - `terminal.data` -- PTY output forwarded to xterm via ptyDataRegistry
 * - `terminal.exit` -- PTY exit forwarded via ptyDataRegistry
 * - Reconnect-gap banners are emitted from ws-transport after `terminal.reattach` RPC
 *   (there is no `terminal.reconnectGap` push channel on the server)
 * - `thread.status` -- thread status changes reflected in threadStore
 * - `thread.lifecycleChanged` -- completion, reopen, or cleanup state persisted by the server
 * - `thread.deleted` -- successful automatic retention cleanup
 * - `workspace.environment.action.updated` -- retained Project Action lifecycle and output updates
 * - `thread.prLinked` -- PR detected for a thread, updates pr_number/pr_status
 * - `thread.checksUpdated` -- CI check status polled for a thread's PR, updates checksById
 * - `thread.modelUpdated` -- thread model and provider synced after a message send (multi-client)
 * - `files.changed` -- invalidates the file autocomplete cache
 * - `skills.changed` -- invalidates provider catalogs; popup re-fetches on next open
 * - `provider.catalogChanged` -- reconciles a refreshed catalog by stable identity
 * - `turn.persisted` -- tool call persistence confirmation forwarded to threadStore
 * - `settings.changed` -- server-pushed settings updates forwarded to settingsStore
 * - `branch.changed` -- refreshes branch list and updates current branch if not manually overridden
 * - `plan.questions` -- model-proposed plan questions forwarded to threadStore wizard
 * - `plan.answered` -- server committed an answered marker; dismisses the wizard on this client
 * - `plan.generated` -- server extracted a structured plan; updates planStore and shows live preview for the active thread
 * - `permission.request` -- tool permission awaiting user decision
 * - `permission.resolved` -- a permission was settled (by user or session stop)
 * - `providers.availability` -- server-pushed provider availability snapshot forwarded to providerAvailabilityStore
 * - `workspace.gitStatusChanged` -- workspace git status changed (e.g. non-git folder became a repo), updates is_git_repo flag
 * - `workspace.orderChanged` -- sidebar project order changed on the server; refreshes workspace list
 * - `workspace.deleted` -- workspace hard-delete complete; removes it from local state
 * - `workspace.deleteFailed` -- workspace deletion permanently stuck; reloads workspace list
 * - `thread.handoff` -- handoff pipeline status for a child thread (generating, ready, fallback, error)
 */
export function startPushListeners(): void {
  // Guard against double-init
  stopPushListeners();

  const handleAgentEvent = useThreadStore.getState().handleAgentEvent;

  // agent.event: the server wraps each sidecar event with { threadId, type, ... }
  unsubs.push(
    pushEmitter.on("agent.event", (data) => {
      const parsed = WS_CHANNELS["agent.event"].safeParse(data);
      if (!parsed.success) return;
      handleAgentEvent(parsed.data);
    }),
  );

  unsubs.push(
    pushEmitter.on("agent.canonical", (data) => {
      const parsed = WS_CHANNELS["agent.canonical"].safeParse(data);
      if (!parsed.success) return;
      useThreadStore.getState().handleCanonicalAgentEvents(
        parsed.data.threadId,
        parsed.data.events,
      );
    }),
  );

  // terminal.data: forward PTY output to the registered TerminalView callback.
  // Supports multiple payload encodings for forward/backward compatibility:
  //   - Uint8Array: direct binary WebSocket frames (preferred)
  //   - base64 string: IPC path (current) — compact JSON-safe encoding
  //   - number[]: legacy IPC path (pre-base64 servers)
  //   - indexed object: very old servers that sent raw Uint8Array through JSON.stringify
  //   - string "data" field: legacy JSON fallback
  unsubs.push(
    pushEmitter.on("terminal.data", handleTerminalData),
  );

  // terminal.exit: broadcast exit event
  unsubs.push(
    pushEmitter.on("terminal.exit", (data) => {
      const payload = data as { ptyId: string; code: number };
      emitPtyExit(payload);
      // Remove the terminal from the store after a brief delay so the
      // exit message has time to render.
      setTimeout(() => {
        useTerminalStore.getState().removeTerminal(payload.ptyId);
      }, 2000);
    }),
  );

  // thread.status: update running state in the thread store. When the turn
  // terminates without per-tool toolResult events (paused / interrupted /
  // errored), force every in-flight tool call to complete with cancelled
  // state so Agent rows stop spinning and reflect the stop on the parent.
  unsubs.push(
    pushEmitter.on("thread.status", (data) => {
      const { threadId, status } = data as {
        threadId: string;
        status: string;
      };
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, status: status as typeof t.status } : t,
        ),
      }));

      const isTerminal =
        status === "paused" || status === "interrupted" || status === "errored";
      void useThreadControlStore.getState().refreshByThreadId(threadId);
      if (!isTerminal) return;
      useThreadStore.setState((state) => {
        const calls = getThreadRecord(state.records, threadId).toolCalls;
        if (!calls || calls.length === 0) return state;
        let mutated = false;
        const next = calls.map((tc) => {
          if (tc.isComplete) return tc;
          mutated = true;
          return {
            ...tc,
            isComplete: true,
            isError: true,
            output: tc.output ?? "Cancelled",
          };
        });
        if (!mutated) return state;
        return {
          records: patchThreadRecord(state.records, threadId, { toolCalls: next }),
        };
      });
    }),
  );

  // Coordination writes use a dedicated invalidation channel so the panel
  // always re-reads persisted lineage, provenance, lifecycle, and approvals.
  unsubs.push(
    pushEmitter.on("thread.controlChanged", (data) => {
      const parsed = WS_CHANNELS["thread.controlChanged"].safeParse(data);
      if (!parsed.success) return;
      void useThreadControlStore.getState().refreshByThreadId(parsed.data.threadId, parsed.data.workspaceId);
    }),
  );

  unsubs.push(
    pushEmitter.on("thread.lifecycleChanged", (data) => {
      const parsed = WS_CHANNELS["thread.lifecycleChanged"].safeParse(data);
      if (!parsed.success) return;
      useWorkspaceStore.getState().applyThreadLifecycle(parsed.data.thread);
    }),
  );

  unsubs.push(
    pushEmitter.on("thread.deleted", (data) => {
      const parsed = WS_CHANNELS["thread.deleted"].safeParse(data);
      if (!parsed.success) return;
      useWorkspaceStore.getState().applyThreadDeleted(parsed.data.threadId);
      useProjectActionStore.getState().clearThread(parsed.data.threadId);
    }),
  );

  unsubs.push(
    pushEmitter.on("workspace.environment.action.updated", (data) => {
      const parsed = WS_CHANNELS["workspace.environment.action.updated"].safeParse(data);
      if (!parsed.success) return;
      useProjectActionStore.getState().applyRun(parsed.data.run);
    }),
  );

  // thread.prLinked: a PR was detected and linked to a thread
  unsubs.push(
    pushEmitter.on("thread.prLinked", (data) => {
      const { threadId, prNumber, prStatus } = data as {
        threadId: string;
        prNumber: number;
        prStatus: string;
      };
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, pr_number: prNumber, pr_status: prStatus } : t,
        ),
      }));
    }),
  );

  // thread.checksUpdated: CI check status polled for a thread's PR
  unsubs.push(
    pushEmitter.on("thread.checksUpdated", (data) => {
      const { threadId, checks } = data as {
        threadId: string;
        checks: import("@mcode/contracts").ChecksStatus;
      };
      useWorkspaceStore.setState((ws) => ({
        checksById: { ...ws.checksById, [threadId]: checks },
      }));
    }),
  );

  // thread.modelUpdated: thread row model/provider persisted for this send (multi-tab / client)
  unsubs.push(
    pushEmitter.on("thread.modelUpdated", (data) => {
      const { threadId, model, provider } = data as {
        threadId: string;
        model: string;
        provider: string;
      };
      if (!threadId || !model) return;
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, model, provider } : t,
        ),
      }));
    }),
  );

  // thread.checkoutChanged: thread worktree HEAD changed outside Mcode
  unsubs.push(
    pushEmitter.on("thread.checkoutChanged", (data) => {
      const {
        threadId,
        workspaceId,
        branch,
        checkoutState,
        baseBranch,
        prNumber,
        prStatus,
      } = data as {
        threadId: string;
        workspaceId: string;
        branch: string;
        checkoutState: "named" | "branchless";
        baseBranch: string | null;
        prNumber: number | null;
        prStatus: string | null;
      };
      if (!threadId || !workspaceId || !branch) return;
      useWorkspaceStore.setState((ws) => {
        const prUrlsByThreadId = { ...ws.prUrlsByThreadId };
        const checksById = { ...ws.checksById };
        delete prUrlsByThreadId[threadId];
        delete checksById[threadId];
        return {
          threads: ws.threads.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  branch,
                  checkout_state: checkoutState,
                  base_branch: baseBranch,
                  pr_number: prNumber,
                  pr_status: prStatus,
                }
              : t,
          ),
          prUrlsByThreadId,
          checksById,
        };
      });
    }),
  );

  // files.changed: invalidate file autocomplete cache
  unsubs.push(
    pushEmitter.on("files.changed", (data) => {
      const { workspaceId, threadId } = data as {
        workspaceId: string;
        threadId?: string;
      };
      clearFileListCache(workspaceId, threadId);
      useDiffStore.getState().bumpDiffRevision(threadId ?? workspaceId);
    }),
  );

  // skills.changed only covers providers backed by the shared filesystem scanner.
  // Codex invalidations arrive as provider.catalogChanged from app-server.
  unsubs.push(
    pushEmitter.on("skills.changed", (data) => {
      const parsed = WS_CHANNELS["skills.changed"].safeParse(data);
      if (!parsed.success) return;
      if (skillsInvalidationTimer !== null) {
        clearTimeout(skillsInvalidationTimer);
      }
      skillsInvalidationTimer = setTimeout(() => {
        skillsInvalidationTimer = null;
        useProviderCatalogStore.getState().invalidate(parsed.data.providerIds);
      }, SKILLS_INVALIDATION_DEBOUNCE_MS);
    }),
  );

  unsubs.push(
    pushEmitter.on("provider.catalogChanged", (change) => {
      const parsed = ProviderCatalogChangeSchema().safeParse(change);
      if (!parsed.success) return;
      useProviderCatalogStore.getState().reconcile(parsed.data);
    }),
  );

  // turn.persisted: server has persisted tool calls for a completed turn
  unsubs.push(
    pushEmitter.on("turn.fileEffectsUpdated", (data) => {
      const payload = data as { threadId: string; turnId: string; summary: TurnFileEffectSummary };
      useThreadStore.getState().handleFileEffectsUpdated(
        payload.threadId,
        payload.turnId,
        payload.summary,
      );
    }),
  );

  unsubs.push(
    pushEmitter.on("turn.savingStatus", (data) => {
      const parsed = WS_CHANNELS["turn.savingStatus"].safeParse(data);
      if (!parsed.success) return;
      useThreadStore.getState().setTurnSavingStatus(parsed.data);
    }),
  );

  // turn.persisted: server has persisted tool calls for a completed turn
  unsubs.push(
    pushEmitter.on("turn.persisted", (data) => {
      const payload = data as {
        threadId: string;
        turnId?: string | null;
        executionId?: string | null;
        messageId: string;
        outcome?: "completed" | "cancelled" | "interrupted" | "errored" | null;
        toolCallCount: number;
        filesChanged: string[];
        fileEffects?: TurnFileEffectSummary;
      };
      useThreadStore.getState().handleTurnPersisted(payload);

      refreshTurnSnapshotsAfterPersist(payload.threadId, payload.filesChanged);

      const hasFileChanges = payload.filesChanged.length > 0;
      if (!hasFileChanges) return;

      const thread = useWorkspaceStore
        .getState()
        .threads.find((candidate) => candidate.id === payload.threadId);
      if (thread) clearFileListCache(thread.workspace_id, payload.threadId);

      try {
        const transport = getTransport();
        const snap = useDiffStore.getState();
        const hasCommits = snap.commitsByThread[payload.threadId] !== undefined;

        if (hasCommits) {
          const thread = useWorkspaceStore
            .getState()
            .threads.find((t) => t.id === payload.threadId);
          if (!thread) return;
          transport
            .getGitLog(thread.workspace_id, thread.branch, 100)
            .then((commits) => {
              const current = useDiffStore.getState().commitsByThread[payload.threadId];
              if (
                current &&
                commits.length === current.length &&
                commits.every((c, i) => c.sha === current[i].sha)
              ) {
                return;
              }
              useDiffStore.getState().setCommits(payload.threadId, commits);
            })
            .catch(() => { /* non-critical */ });
        }
      } catch {
        // Transport not initialized — ignore (startup race / tests).
      }
    }),
  );

  // settings.changed: update settings store with server-pushed changes
  unsubs.push(
    pushEmitter.on("settings.changed", (data) => {
      const settings = data as Settings;
      useSettingsStore.getState()._applyPush(settings);
    }),
  );

  // branch.changed: refresh branch list and update current branch if not manually overridden
  unsubs.push(
    pushEmitter.on("branch.changed", (data) => {
      const { workspaceId, branch } = data as { workspaceId: string; branch: string | null };
      const state = useWorkspaceStore.getState();
      // Only refresh if this event is for the active workspace
      if (state.activeWorkspaceId === workspaceId) {
        state.loadBranches(workspaceId);
        if (!state.branchManuallySelected && branch) {
          state.setNewThreadBranch(branch);
        }
      }
    }),
  );

  // workspace.gitStatusChanged: update is_git_repo flag when a non-git workspace becomes a git repo
  unsubs.push(
    pushEmitter.on("workspace.gitStatusChanged", (data) => {
      const { workspaceId, isGitRepo } = data as { workspaceId: string; isGitRepo: boolean };
      useWorkspaceStore.setState((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, is_git_repo: isGitRepo } : w,
        ),
      }));
    }),
  );

  unsubs.push(
    pushEmitter.on("workspace.orderChanged", () => {
      void useWorkspaceStore.getState().loadWorkspaces();
    }),
  );

  // workspace.deleted: remove the workspace from local state when hard-delete completes
  unsubs.push(
    pushEmitter.on("workspace.deleted", (data) => {
      const { workspaceId } = data as { workspaceId: string };
      const store = useWorkspaceStore.getState();
      if (store.activeWorkspaceId === workspaceId) {
        store.setActiveWorkspace(null);
      }
      store.removeWorkspaceFromState(workspaceId);
    }),
  );

  // workspace.deleteFailed: reload workspaces so stuck state is reflected
  unsubs.push(
    pushEmitter.on("workspace.deleteFailed", (data) => {
      const { workspaceId, reason } = data as { workspaceId: string; reason: string };
      void useWorkspaceStore.getState().loadWorkspaces();
      console.error(`Workspace ${workspaceId} deletion failed: ${reason}`);
    }),
  );

  // plan.questions: model proposed clarifying questions in plan mode
  unsubs.push(
    pushEmitter.on("plan.questions", (data) => {
      const { threadId, questions } = data as {
        threadId: string;
        questions: import("@mcode/contracts").PlanQuestion[];
      };
      if (!threadId || !Array.isArray(questions)) return;
      useThreadStore.getState().setPlanQuestions(threadId, questions);
    }),
  );

  // plan.answered: server committed an answered marker for a plan-questions
  // message via the SUBMIT path. Adds to recentlyAnsweredPlanMessageIds so
  // the AnsweredSummary marker can play its one-shot echo on first paint.
  unsubs.push(
    pushEmitter.on("plan.answered", (data) => {
      const { threadId, assistantMessageId } = data as {
        threadId: string;
        assistantMessageId: string;
      };
      if (!threadId || !assistantMessageId) return;
      useThreadStore.getState().markPlanAnswered(threadId, assistantMessageId);
    }),
  );

  // plan.dismissed: server committed the marker via the CANCEL path. Same
  // state update (the batch is settled, wizard hides on other tabs) but
  // skips the echo animation — dismiss is not submission.
  unsubs.push(
    pushEmitter.on("plan.dismissed", (data) => {
      const { threadId, assistantMessageId } = data as {
        threadId: string;
        assistantMessageId: string;
      };
      if (!threadId || !assistantMessageId) return;
      useThreadStore.getState().markPlanDismissed(threadId, assistantMessageId);
    }),
  );

  // plan.generated: server extracted a structured plan from agent output
  unsubs.push(
    pushEmitter.on("plan.generated", (data) => {
      const { threadId, plan } = data as {
        threadId: string;
        plan: import("@mcode/contracts").PlanRecord;
      };
      if (!threadId || !plan) return;

      usePlanStore.getState().addPlan(threadId, plan);
      if (useWorkspaceStore.getState().activeThreadId === threadId) {
        usePlanStore.getState().showLivePreview(threadId, plan);
      }
    }),
  );

  // permission.request: tool permission awaiting user decision
  unsubs.push(
    pushEmitter.on("permission.request", (data) => {
      const request = data as PermissionRequest;
      if (!request.requestId || !request.threadId) return;
      useThreadStore.getState().addPermissionRequest(request);
      void useThreadControlStore.getState().refreshByThreadId(request.threadId);
      if (request.sourceThreadId) {
        void useThreadControlStore.getState().refreshByThreadId(request.sourceThreadId);
      }
    }),
  );

  // permission.resolved: a permission was settled (by user or session stop)
  unsubs.push(
    pushEmitter.on("permission.resolved", (data) => {
      const { requestId, decision } = data as {
        requestId: string;
        decision: PermissionDecision;
      };
      void useThreadControlStore.getState().rehydrate();
      if (!requestId) return;
      useThreadStore.getState().resolvePermissionRequest(requestId, decision);
    }),
  );

  // providers.availability: server-pushed snapshot of all provider availability records
  unsubs.push(
    pushEmitter.on("providers.availability", (data) => {
      // Reject malformed payloads rather than overwriting the store with garbage.
      if (!Array.isArray(data)) return;
      useProviderAvailabilityStore.getState().replace(data as ProviderAvailability[]);
    }),
  );

  // thread.handoff: handoff pipeline status for a child thread (generating -> ready/fallback/error)
  unsubs.push(
    pushEmitter.on("thread.handoff", (data) => {
      const payload = data as {
        threadId: string;
        status: "generating" | "ready" | "fallback" | "error";
        ladderStep?: "B" | "D";
        providerErrorOnGenerate?: "quota" | "auth" | "context-overflow" | "transient" | "fatal" | null;
      };
      if (!payload.threadId || !payload.status) return;
      useThreadStore.getState().setHandoffMeta(payload.threadId, {
        status: payload.status,
        ladderStep: payload.ladderStep,
        providerErrorOnGenerate: payload.providerErrorOnGenerate,
      });
    }),
  );

}

/** Remove all push channel listeners. Safe to call multiple times. */
export function stopPushListeners(): void {
  if (skillsInvalidationTimer !== null) {
    clearTimeout(skillsInvalidationTimer);
    skillsInvalidationTimer = null;
  }
  for (const unsub of unsubs) {
    unsub();
  }
  unsubs = [];
}
