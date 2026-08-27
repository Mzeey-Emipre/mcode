import { Lifecycle, type DependencyContainer } from "tsyringe";

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
