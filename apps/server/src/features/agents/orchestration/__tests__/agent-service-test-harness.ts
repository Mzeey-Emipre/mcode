import type { Database } from "bun:sqlite";
import { TurnDiffService } from "../../turns/turn-diff-service.js";
import { TurnDiffRepo } from "../../turns/persistence/turn-diff-repo.js";
import { container, Lifecycle } from "tsyringe";
import type {
  AgentEvent,
  IProviderRegistry,
  ProviderRuntimeEvent,
} from "@mcode/contracts";
import type * as NodeEvents from "node:events";

import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { WorkspaceEnvironmentService } from "../../../projects/index.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { GitRepositoryService } from "../../../projects/git/git-repository-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ThreadService } from "../../../thread-control/index.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
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
import { PARENT_TURN_DURABILITY } from "../../turns/parent-turn-durability.js";
import { PostTerminalHookCompletionEffect } from "../../turns/post-terminal-hook-completion-effect.js";
import { ProviderSessionCursorPersistence } from "../../turns/provider-session-cursor-persistence.js";
import { ThreadCreationCoordinator } from "../../turns/thread-creation-coordinator.js";
import { TurnAdmissionDispatchCoordinator } from "../../turns/turn-admission-dispatch-coordinator.js";
import { TurnConversationProjectionService } from "../../turns/turn-conversation-projection-service.js";
import { TurnFileEffects } from "../../turns/turn-file-effects.js";
import { TURN_FILE_EFFECTS } from "../../turns/turn-file-effects.js";
import { TurnFileTracker } from "../../turns/turn-file-tracker.js";
import { TurnFinalizer, type TurnSnapshotPersistence } from "../../turns/turn-finalizer.js";
import { ThreadRuntimePersistence, TURN_RUNTIME_PERSISTENCE } from "../../turns/turn-runtime-persistence.js";
import { TURN_FINALIZER } from "../../turns/turn-finalizer.js";
import { TURN_ADMISSION_DISPATCH_COORDINATOR } from "../../turns/turn-admission-dispatch-coordinator.js";
import { TURN_FEATURE_EFFECTS } from "../../turns/turn-feature-effects.js";
import { InternalThreadControlMcpRuntime, ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { ProviderEventIngress } from "../../../providers/composition/provider-event-ingress.js";
import { ThreadBranchingService } from "../../../projects/worktrees/thread-branching-service.js";
import { AgentService } from "../agent-service.js";
import { AgentRuntimeCommandPort } from "../agent-turn-command-port.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";
import { AgentReliabilityPort } from "../agent-runtime-internal-ports.js";
import { TurnFeatureEffects } from "../../turns/turn-feature-effects.js";
import { AgentEventPublicationRuntimePort, AgentTurnContinuationPort } from "../agent-runtime-internal-ports.js";
import { TurnRuntimeController } from "../turn-runtime-controller.js";
import { ProviderTurnEventApplication } from "../../turns/provider-turn-event-application.js";
import { TURN_RUNTIME_EVENT_CONTROL, type TurnRuntimeEventControl } from "../turn-runtime-event-control.js";

const testEventPublications = new WeakMap<AgentService, AgentEventPublicationRegistry>();
const testReliabilityPorts = new WeakMap<AgentService, AgentReliabilityPort>();
const testContinuations = new WeakMap<AgentService, AgentTurnContinuationPort>();
const testProviderTurnStarts = new WeakMap<AgentService, (threadId: string) => string>();
const testFinalizers = new WeakMap<AgentService, TurnFinalizer>();
const testMessageRepos = new WeakMap<AgentService, MessageRepo>();
const testTrackers = new WeakMap<AgentService, TurnFileTracker>();
const testTurnDiffs = new WeakMap<AgentService, TurnDiffService>();

/** Read the real native evidence service wired through the test runtime and ingress. */
export function turnDiffsForAgentServiceTest(service: AgentService): TurnDiffService {
  const turnDiffs = testTurnDiffs.get(service);
  if (!turnDiffs) throw new Error("Agent service was not created by this harness");
  return turnDiffs;
}
const testGoalLifecycles = new WeakMap<AgentService, GoalLifecycleService>();

/** Wrap test provider events at the same runtime boundary as real providers. */
export function runtimeProviderEvent(event: AgentEvent): ProviderRuntimeEvent {
  return { event };
}

/** Make a test EventEmitter publish provider runtime envelopes. */
export function wrapProviderEmitterForRuntimeEvents<T extends NodeEvents.EventEmitter>(emitter: T): T {
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

/** Continue an active turn through the existing runtime port. */
export function continueAgentTurnWithoutSavingForTest(service: AgentService, executionId: string): void {
  const continuation = testContinuations.get(service);
  if (!continuation) throw new Error("AgentService test continuation is unavailable");
  continuation.continueWithoutSaving(executionId);
}

/** Start one raw provider turn through the controller's provider-ingress seam. */
export function startProviderTurnForTest(service: AgentService, threadId: string): string {
  const start = testProviderTurnStarts.get(service);
  if (!start) throw new Error("AgentService test provider-turn start is unavailable");
  return start(threadId);
}

/** Return the terminal persistence owner for focused event-ordering tests. */
export function finalizerForAgentServiceTest(service: AgentService): TurnFinalizer {
  const finalizer = testFinalizers.get(service);
  if (!finalizer) throw new Error("AgentService test finalizer is unavailable");
  return finalizer;
}

/** Return the message persistence dependency used by the focused fixture. */
export function messageRepoForAgentServiceTest(service: AgentService): MessageRepo {
  const messages = testMessageRepos.get(service);
  if (!messages) throw new Error("AgentService test messages are unavailable");
  return messages;
}

/** Return the file tracker used by a focused runtime fixture. */
export function fileTrackerForAgentServiceTest(service: AgentService): TurnFileTracker {
  const tracker = testTrackers.get(service);
  if (!tracker) throw new Error("AgentService test file tracker is unavailable");
  return tracker;
}

/** Return the goal owner used by a focused runtime fixture. */
export function goalLifecycleForAgentServiceTest(service: AgentService): GoalLifecycleService {
  const goals = testGoalLifecycles.get(service);
  if (!goals) throw new Error("AgentService test goal lifecycle is unavailable");
  return goals;
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
  db: Database,
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
  threadStartups?: ThreadStartupService,
): AgentService {
  if (!parentDurability) throw new Error("Parent turn durability is required by the test harness");
  const turnDiffs = new TurnDiffService(new TurnDiffRepo(db));
  const tracker = new TurnFileTracker(
    (cwd, ref, path) => snapshotService.getFileAtRef(cwd, ref, path),
    () => undefined,
    "win32",
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
    turnDiffs,
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
    "linux",
  );
  const conversationProjection = new TurnConversationProjectionService(
    threadRepo,
    messageRepo,
    finalizer,
    parentDurability,
  );
  const publication = eventPublication ?? new AgentEventPublicationRegistry();
  const reliability = new AgentReliabilityPort();
  const continuation = new AgentTurnContinuationPort();
  const runtimePersistence = new ThreadRuntimePersistence(threadRepo);
  const eventIngress = providerEventIngress ?? new ProviderEventIngress();
  const testThreadControl = threadControlMcp ?? {
    activate: () => undefined,
    revoke: () => undefined,
  } as unknown as InternalThreadControlMcpRuntime;
  const testContainer = container.createChildContainer();
  const gitRepository = new GitRepositoryService(workspaceRepo, new FakeGitExecutor());
  testContainer.registerInstance(TURN_RUNTIME_PERSISTENCE, runtimePersistence);
  testContainer.registerInstance(TURN_FINALIZER, finalizer);
  testContainer.registerInstance(TURN_FILE_EFFECTS, fileEffects);
  testContainer.registerInstance(TURN_ADMISSION_DISPATCH_COORDINATOR, admissions);
  testContainer.registerInstance(TurnConversationProjectionService, conversationProjection);
  testContainer.registerInstance(PostTerminalHookCompletionEffect, new PostTerminalHookCompletionEffect(hookExecutionRepo, finalizer));
  testContainer.registerInstance(ProviderSessionCursorPersistence, new ProviderSessionCursorPersistence(runtimePersistence, parentDurability));
  testContainer.registerInstance(ThreadCreationCoordinator, new ThreadCreationCoordinator(
    threadRepo,
    () => threadService,
    admissions,
    gitRepository,
    () => threadBranching,
    () => planTurns,
    () => threadStartups,
  ));
  testContainer.registerInstance("IProviderRegistry", providerRegistry);
  testContainer.registerInstance(MemoryPressureService, memoryPressureService);
  testContainer.registerInstance(ScopedPreGrantService, scopedPreGrant);
  testContainer.registerInstance(InternalThreadControlMcpRuntime, testThreadControl);
  testContainer.registerInstance(
    ThreadControlMutationReservationService,
    mutationReservations ?? new ThreadControlMutationReservationService(),
  );
  testContainer.registerInstance(ProviderEventIngress, eventIngress);
  testContainer.registerInstance(TURN_FEATURE_EFFECTS, featureEffects);
  testContainer.registerInstance(AgentRuntimeCommandPort, runtimeCommands);
  testContainer.registerInstance(AgentEventPublicationRuntimePort, new AgentEventPublicationRuntimePort());
  testContainer.registerInstance(AgentTurnContinuationPort, continuation);
  testContainer.registerInstance(AgentReliabilityPort, reliability);
  testContainer.registerInstance(AgentEventPublicationRegistry, publication);
  testContainer.registerInstance(PARENT_TURN_DURABILITY, parentDurability);
  testContainer.registerInstance(NarrativeStore, narrativeStore);
  testContainer.registerInstance(ParentAssistantTextCheckpointService, parentAssistantTextCheckpoints);
  testContainer.registerInstance("Database", db);
  testContainer.registerInstance(TurnDiffService, turnDiffs);
  testContainer.register<TurnRuntimeEventControl>(TURN_RUNTIME_EVENT_CONTROL, {
    useFactory: (c) => c.resolve(TurnRuntimeController),
  });
  testContainer.register(ProviderTurnEventApplication, { useClass: ProviderTurnEventApplication }, { lifecycle: Lifecycle.Singleton });
  testContainer.register(TurnRuntimeController, { useClass: TurnRuntimeController }, { lifecycle: Lifecycle.Singleton });
  testContainer.register(AgentService, { useClass: AgentService }, { lifecycle: Lifecycle.Singleton });
  const service = testContainer.resolve(AgentService);
  const runtimeController = testContainer.resolve(TurnRuntimeController);
  testFinalizers.set(service, finalizer);
  testMessageRepos.set(service, messageRepo);
  testEventPublications.set(service, publication);
  testReliabilityPorts.set(service, reliability);
  testContinuations.set(service, continuation);
  testProviderTurnStarts.set(service, (threadId) => runtimeController.beginProviderTurn(threadId));
  testTrackers.set(service, tracker);
  testTurnDiffs.set(service, turnDiffs);
  testGoalLifecycles.set(service, resolvedGoals);
  return service;
}
