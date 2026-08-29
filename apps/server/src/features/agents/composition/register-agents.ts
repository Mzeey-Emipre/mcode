import { Lifecycle, instanceCachingFactory, type DependencyContainer } from "tsyringe";
import { broadcast } from "../../../application/transport/push.js";

import {
  AgentPermissionService,
  AgentService,
  CanonicalAgentBoundary,
  CanonicalAgentEventSink,
  ParentAssistantTextCheckpointService,
  publishCanonicalAgentEvents,
  TurnRecoveryService,
} from "../index.js";
import { LegacyConversationMigration } from "../conversation/migrations/legacy-conversation-migration.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { PlanQuestionService } from "../planning/plan-question-service.js";
import { PlanQuestionAnswersRepo } from "../planning/persistence/plan-question-answers-repo.js";
import { TurnSnapshotRepo } from "../turns/persistence/turn-snapshot-repo.js";
import {
  CODEX_COLLABORATION_DURABILITY,
  type CodexCollaborationDurability,
} from "../collaboration/codex-collaboration-durability.js";
import {
  SUBAGENT_LIFECYCLE_DURABILITY,
} from "../collaboration/subagent-lifecycle-durability.js";
import { SubagentLifecycleService } from "../collaboration/subagent-lifecycle-service.js";
import { GoalLifecycleService } from "../goals/goal-lifecycle-service.js";
import { PlanTurnService } from "../planning/plan-turn-service.js";
import { TaskPersistenceService } from "../tasks/task-persistence-service.js";
import {
  PARENT_TURN_DURABILITY,
} from "../turns/parent-turn-durability.js";
import {
  AGENT_TURN_COMMAND_PORT,
  AgentRuntimeCommandPort,
  AgentTurnCommandPort,
} from "../orchestration/agent-turn-command-port.js";
import { AgentEventPublicationRegistry } from "../orchestration/agent-event-publication-registry.js";
import {
  AgentEventPublicationRuntimePort,
  AgentReliabilityPort,
  AgentTurnContinuationPort,
} from "../orchestration/agent-runtime-internal-ports.js";
import { TURN_FEATURE_EFFECTS, TurnFeatureEffects } from "../turns/turn-feature-effects.js";
import { ThreadBranchingService } from "../../projects/worktrees/thread-branching-service.js";
import { ThreadService } from "../../thread-control/index.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import { FileService } from "../../projects/files/file-service.js";
import { WorkspaceEnvironmentService } from "../../projects/index.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import { SettingsService } from "../../settings/settings-service.js";
import { TURN_FINALIZER, TurnFinalizer } from "../turns/turn-finalizer.js";
import { TURN_FILE_TRACKER, TurnFileTracker } from "../turns/turn-file-tracker.js";
import { TURN_FILE_EFFECTS, TurnFileEffects } from "../turns/turn-file-effects.js";
import {
  TURN_ADMISSION_DISPATCH_COORDINATOR,
  TurnAdmissionDispatchCoordinator,
} from "../turns/turn-admission-dispatch-coordinator.js";
import {
  TURN_RUNTIME_PERSISTENCE,
  ThreadRuntimePersistence,
  type TurnRuntimePersistence,
} from "../turns/turn-runtime-persistence.js";
import { TurnConversationProjectionService } from "../turns/turn-conversation-projection-service.js";
import { PostTerminalHookCompletionEffect } from "../turns/post-terminal-hook-completion-effect.js";
import { ThreadCreationCoordinator } from "../turns/thread-creation-coordinator.js";
import { ProviderSessionCursorPersistence } from "../turns/provider-session-cursor-persistence.js";

/** Register agent orchestration, event, recovery, and planning services. */
export function registerAgentServices(container: DependencyContainer): void {
  container.register(
    NarrativeStore,
    { useClass: NarrativeStore },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("NarrativeStore", {
    useFactory: (c) => c.resolve(NarrativeStore),
  });
  container.register("CanonicalAgentEventPublisher", {
    useValue: publishCanonicalAgentEvents,
  });
  container.register(
    CanonicalAgentBoundary,
    { useClass: CanonicalAgentBoundary },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register<CodexCollaborationDurability>(CODEX_COLLABORATION_DURABILITY, {
    useFactory: (c) => c.resolve(CanonicalAgentBoundary),
  });
  container.register(PARENT_TURN_DURABILITY, {
    useFactory: (c) => c.resolve(CanonicalAgentBoundary),
  });
  container.register(SUBAGENT_LIFECYCLE_DURABILITY, {
    useFactory: (c) => c.resolve(CanonicalAgentBoundary),
  });
  container.register(CanonicalAgentEventSink, {
    useFactory: (c) => c.resolve(CanonicalAgentBoundary) as CanonicalAgentEventSink,
  });
  container.register(
    ParentAssistantTextCheckpointService,
    { useClass: ParentAssistantTextCheckpointService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    LegacyConversationMigration,
    { useClass: LegacyConversationMigration },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    TurnRecoveryService,
    { useClass: TurnRecoveryService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    PlanQuestionService,
    { useClass: PlanQuestionService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PlanQuestionService", {
    useFactory: (c) => c.resolve(PlanQuestionService),
  });
  container.register("PlanAnswerMarker", {
    useFactory: (c) => c.resolve(PlanQuestionAnswersRepo),
  });
  container.register("TurnSnapshotPersistence", {
    useFactory: (c) => c.resolve(TurnSnapshotRepo),
  });
  container.register(PlanTurnService, { useClass: PlanTurnService }, { lifecycle: Lifecycle.Singleton });
  container.register(GoalLifecycleService, { useClass: GoalLifecycleService }, { lifecycle: Lifecycle.Singleton });
  container.register(SubagentLifecycleService, { useClass: SubagentLifecycleService }, { lifecycle: Lifecycle.Singleton });
  container.register(TaskPersistenceService, { useClass: TaskPersistenceService }, { lifecycle: Lifecycle.Singleton });
  container.register<TurnFeatureEffects>(TURN_FEATURE_EFFECTS, {
    useFactory: instanceCachingFactory((c) => new TurnFeatureEffects(
      c.resolve(PlanTurnService),
      c.resolve(GoalLifecycleService),
      c.resolve(SubagentLifecycleService),
      c.resolve(TaskPersistenceService),
    )),
  });
  container.register(AgentRuntimeCommandPort, { useClass: AgentRuntimeCommandPort }, { lifecycle: Lifecycle.Singleton });
  container.register(AgentEventPublicationRuntimePort, { useClass: AgentEventPublicationRuntimePort }, { lifecycle: Lifecycle.Singleton });
  container.register(AgentTurnContinuationPort, { useClass: AgentTurnContinuationPort }, { lifecycle: Lifecycle.Singleton });
  container.register(AgentReliabilityPort, { useClass: AgentReliabilityPort }, { lifecycle: Lifecycle.Singleton });
  container.register(AgentEventPublicationRegistry, { useClass: AgentEventPublicationRegistry }, { lifecycle: Lifecycle.Singleton });
  container.register(AGENT_TURN_COMMAND_PORT, {
    useFactory: (c) => new AgentTurnCommandPort(c.resolve(AgentRuntimeCommandPort)),
  });
  container.register(ThreadBranchingService, { useClass: ThreadBranchingService }, { lifecycle: Lifecycle.Singleton });
  container.register<TurnRuntimePersistence>(TURN_RUNTIME_PERSISTENCE, {
    useFactory: (c) => c.resolve(ThreadRuntimePersistence),
  });
  container.register<TurnFileTracker>(TURN_FILE_TRACKER, {
    useFactory: instanceCachingFactory((c) => {
      const snapshots = c.resolve(SnapshotService);
      return new TurnFileTracker(
        (cwd, ref, path) => snapshots.getFileAtRef(cwd, ref, path),
        (threadId, turnId, summary) => {
          broadcast("turn.fileEffectsUpdated", { threadId, turnId, summary });
        },
      );
    }),
  });
  container.register<TurnFinalizer>(TURN_FINALIZER, {
    useFactory: instanceCachingFactory((c) => new TurnFinalizer(
      c.resolve(MessageRepo),
      c.resolve(ThreadRepo),
      c.resolve(NarrativeStore),
      c.resolve(SnapshotService),
      c.resolve("TurnSnapshotPersistence"),
      c.resolve("Database"),
      c.resolve<TurnFileTracker>(TURN_FILE_TRACKER),
      c.resolve(PARENT_TURN_DURABILITY),
      c.resolve(ParentAssistantTextCheckpointService),
    )),
  });
  container.register<TurnFileEffects>(TURN_FILE_EFFECTS, {
    useFactory: instanceCachingFactory((c) => new TurnFileEffects(
      c.resolve(ThreadRepo),
      c.resolve(WorkspaceRepo),
      c.resolve(GitWorktreeService),
      c.resolve(SnapshotService),
      c.resolve(TURN_FILE_TRACKER),
      c.resolve(TURN_FINALIZER),
    )),
  });
  container.register<TurnAdmissionDispatchCoordinator>(TURN_ADMISSION_DISPATCH_COORDINATOR, {
    useFactory: instanceCachingFactory((c) => new TurnAdmissionDispatchCoordinator(
      c.resolve(ThreadRepo),
      c.resolve(WorkspaceRepo),
      c.resolve(MessageRepo),
      c.resolve(GitWorktreeService),
      c.resolve(AttachmentService),
      c.resolve("IProviderRegistry"),
      c.resolve(ProviderAvailabilityService),
      c.resolve("PlanAnswerMarker"),
      c.resolve(PARENT_TURN_DURABILITY),
      c.resolve(SettingsService),
      c.resolve(PlanTurnService),
      c.resolve(GoalLifecycleService),
      c.resolve(WorkspaceEnvironmentService),
      c.resolve(FileService),
    )),
  });
  container.register(TurnConversationProjectionService, { useClass: TurnConversationProjectionService }, { lifecycle: Lifecycle.Singleton });
  container.register(PostTerminalHookCompletionEffect, { useClass: PostTerminalHookCompletionEffect }, { lifecycle: Lifecycle.Singleton });
  container.register(ProviderSessionCursorPersistence, { useClass: ProviderSessionCursorPersistence }, { lifecycle: Lifecycle.Singleton });
  container.register(ThreadCreationCoordinator, {
    useFactory: instanceCachingFactory((c) => new ThreadCreationCoordinator(
      c.resolve(ThreadRepo),
      () => c.resolve(ThreadService),
      c.resolve(TURN_ADMISSION_DISPATCH_COORDINATOR),
      () => c.resolve(ThreadBranchingService),
      () => c.resolve(PlanTurnService),
    )),
  });
  container.register(
    AgentService,
    { useClass: AgentService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    AgentPermissionService,
    { useClass: AgentPermissionService },
    { lifecycle: Lifecycle.Singleton },
  );
}
