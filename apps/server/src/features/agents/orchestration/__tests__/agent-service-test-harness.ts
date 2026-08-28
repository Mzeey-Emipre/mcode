import type Database from "better-sqlite3";
import type {
  AgentEvent,
  IProviderRegistry,
  ProviderRuntimeEvent,
} from "@mcode/contracts";
import type { EventEmitter } from "node:events";

import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { WorkspaceEnvironmentService } from "../../../projects/index.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ThreadService } from "../../../thread-control/index.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { ScopedPreGrantService } from "../../permissions/scoped-pre-grant.js";
import { TaskPersistenceService } from "../../tasks/task-persistence-service.js";
import { SubagentLifecycleService } from "../../collaboration/subagent-lifecycle-service.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { ParentTurnDurability } from "../../turns/parent-turn-durability.js";
import { PostTerminalHookCompletionEffect } from "../../turns/post-terminal-hook-completion-effect.js";
import { ProviderSessionCursorPersistence } from "../../turns/provider-session-cursor-persistence.js";
import { ThreadCreationCoordinator } from "../../turns/thread-creation-coordinator.js";
import { TurnAdmissionDispatchCoordinator } from "../../turns/turn-admission-dispatch-coordinator.js";
import { TurnConversationProjectionService } from "../../turns/turn-conversation-projection-service.js";
import { TurnFileEffects } from "../../turns/turn-file-effects.js";
import { TurnFileTracker } from "../../turns/turn-file-tracker.js";
import { TurnFinalizer, type TurnSnapshotPersistence } from "../../turns/turn-finalizer.js";
import { ThreadRuntimePersistence } from "../../turns/turn-runtime-persistence.js";
import { InternalThreadControlMcpRuntime, ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { ProviderEventIngress } from "../../../providers/composition/provider-event-ingress.js";
import { ThreadBranchingService } from "../../../projects/worktrees/thread-branching-service.js";
import { AgentService } from "../agent-service.js";
import { AgentRuntimeCommandPort } from "../agent-turn-command-port.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";
import { AgentReliabilityPort } from "../agent-runtime-internal-ports.js";
import { TurnFeatureEffects } from "../../turns/turn-feature-effects.js";

const testEventPublications = new WeakMap<AgentService, AgentEventPublicationRegistry>();
const testReliabilityPorts = new WeakMap<AgentService, AgentReliabilityPort>();

/** Wrap test provider events at the same runtime boundary as real providers. */
export function runtimeProviderEvent(event: AgentEvent): ProviderRuntimeEvent {
  return { event };
}

/** Make a test EventEmitter publish provider runtime envelopes. */
export function wrapProviderEmitterForRuntimeEvents<T extends EventEmitter>(emitter: T): T {
  const emit = emitter.emit.bind(emitter);
  emitter.emit = ((eventName: string, event?: unknown, ...args: unknown[]) => {
    if (eventName !== "event" || !event || typeof event !== "object" || "event" in event) {
      return emit(eventName, event, ...args);
    }
    return emit(eventName, runtimeProviderEvent(event as AgentEvent), ...args);
  }) as T["emit"];
  return emitter;
}

/** Start provider ingress for a test-built service without expanding its production facade. */
export function startAgentServiceIngressForTest(
  service: AgentService,
  publisher?: (event: import("@mcode/contracts").AgentEvent) => void,
): void {
  const publication = testEventPublications.get(service);
  if (!publication) throw new Error("AgentService test publication is unavailable");
  if (publisher) publication.bind(publisher);
  else if (!publication.isBound()) publication.bind(() => undefined);
  publication.start();
}

/** Stream deterministic assistant text through the test-owned reliability port. */
export function streamAgentReliabilityTextForTest(
  service: AgentService,
  threadId: string,
): { threadId: string; executionId: string; text: string } {
  const reliability = testReliabilityPorts.get(service);
  if (!reliability) throw new Error("AgentService test reliability port is unavailable");
  return reliability.streamAssistantText(threadId);
}

/** Build AgentService feature owners for tests that use focused repository fixtures. */
export function createAgentServiceForTest(
  threadRepo: ThreadRepo,
  workspaceRepo: WorkspaceRepo,
  messageRepo: MessageRepo,
  gitWorktrees: GitWorktreeService,
  attachmentService: AttachmentService,
  providerRegistry: IProviderRegistry,
  threadService: ThreadService,
  hookExecutionRepo: HookExecutionRepo,
  turnSnapshotRepo: TurnSnapshotPersistence,
  snapshotService: SnapshotService,
  db: Database.Database,
  memoryPressureService: MemoryPressureService,
  settingsService: SettingsService,
  availability: ProviderAvailabilityService,
  planQuestionAnswers: PlanQuestionAnswersRepo,
  _handoff: unknown,
  scopedPreGrant: ScopedPreGrantService,
  narrativeStore: NarrativeStore,
  parentAssistantTextCheckpoints: ParentAssistantTextCheckpointService,
  fileService?: ConstructorParameters<typeof TurnAdmissionDispatchCoordinator>[13],
  threadControlMcp?: InternalThreadControlMcpRuntime,
  mutationReservations?: ThreadControlMutationReservationService,
  parentDurability?: ParentTurnDurability,
  workspaceEnvironmentService?: WorkspaceEnvironmentService,
  providerEventIngress?: ProviderEventIngress,
  planTurns?: PlanTurnService,
  goals?: GoalLifecycleService,
  subagents?: SubagentLifecycleService,
  taskPersistence?: TaskPersistenceService,
  threadBranching?: ThreadBranchingService,
  eventPublication?: AgentEventPublicationRegistry,
): AgentService {
  if (!parentDurability) throw new Error("Parent turn durability is required by the test harness");
  const tracker = new TurnFileTracker(
    (cwd, ref, path) => snapshotService.getFileAtRef(cwd, ref, path),
    () => undefined,
  );
  const finalizer = new TurnFinalizer(
    messageRepo,
    threadRepo,
    narrativeStore,
    snapshotService,
    turnSnapshotRepo,
    db,
    tracker,
    parentDurability,
    parentAssistantTextCheckpoints,
  );
  const fileEffects = new TurnFileEffects(
    threadRepo,
    workspaceRepo,
    gitWorktrees,
    snapshotService,
    tracker,
    finalizer,
  );
  const runtimeCommands = new AgentRuntimeCommandPort();
  const resolvedPlans = planTurns ?? Object.assign(Object.create(PlanTurnService.prototype), {
    beginOutputGeneration: () => undefined,
    beginQuestionGeneration: () => undefined,
    buildQuestionPrompt: (content: string) => content,
    buildPlanOutputInstructions: () => "",
    onTextDelta: () => undefined,
    needsAssistantMaterialization: () => false,
    persistAssistantMessage: () => undefined,
    clearTurn: () => undefined,
  }) as PlanTurnService;
  const resolvedGoals = goals ?? new GoalLifecycleService(
    threadRepo,
    providerRegistry,
    messageRepo,
    db,
    runtimeCommands,
  );
  const featureEffects = new TurnFeatureEffects(
    resolvedPlans,
    resolvedGoals,
    subagents ?? ({ stopDescendants: () => undefined } as unknown as SubagentLifecycleService),
    taskPersistence ?? ({ onToolUse: () => undefined, onToolResult: () => undefined } as unknown as TaskPersistenceService),
  );
  const admissions = new TurnAdmissionDispatchCoordinator(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitWorktrees,
    attachmentService,
    providerRegistry,
    availability,
    planQuestionAnswers,
    parentDurability,
    settingsService,
    resolvedPlans,
    resolvedGoals,
    workspaceEnvironmentService,
    fileService,
  );
  const conversationProjection = new TurnConversationProjectionService(
    threadRepo,
    messageRepo,
    finalizer,
    parentDurability,
  );
  const publication = eventPublication ?? new AgentEventPublicationRegistry();
  const reliability = new AgentReliabilityPort();
  const service = new AgentService(
    new ThreadRuntimePersistence(threadRepo),
    finalizer,
    fileEffects,
    admissions,
    conversationProjection,
    new PostTerminalHookCompletionEffect(hookExecutionRepo, finalizer),
    new ProviderSessionCursorPersistence(new ThreadRuntimePersistence(threadRepo), parentDurability),
    new ThreadCreationCoordinator(threadRepo, () => threadService, admissions, () => threadBranching, () => planTurns),
    providerRegistry,
    memoryPressureService,
    db,
    scopedPreGrant,
    narrativeStore,
    parentAssistantTextCheckpoints,
    threadControlMcp,
    mutationReservations,
    parentDurability,
    providerEventIngress ?? new ProviderEventIngress(),
    featureEffects,
    runtimeCommands,
    undefined,
    undefined,
    reliability,
    publication,
  );
  testEventPublications.set(service, publication);
  testReliabilityPorts.set(service, reliability);
  Object.assign(service as unknown as { turnFileTracker: TurnFileTracker }, {
    turnFileTracker: tracker,
  });
  Object.defineProperty(service, "messageRepo", {
    get: () => (conversationProjection as unknown as { messages: MessageRepo }).messages,
    set: (messages: MessageRepo) => {
      (conversationProjection as unknown as { messages: MessageRepo }).messages = messages;
    },
  });
  Object.defineProperty(service, "goalEffectsForTest", {
    value: resolvedGoals,
  });
  return service;
}
