import { Lifecycle, type DependencyContainer } from "tsyringe";

import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { ThoughtSegmentRepo } from "../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../events/persistence/hook-execution-repo.js";
import { TaskRepo } from "../orchestration/persistence/task-repo.js";
import { PlanQuestionAnswersRepo } from "../planning/persistence/plan-question-answers-repo.js";
import { PlanRepo } from "../planning/persistence/plan-repo.js";
import { ToolCallRecordRepo } from "../tools/persistence/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "../turns/persistence/turn-snapshot-repo.js";

/** Register agent-owned repositories and their string-keyed injection aliases. */
export function registerAgentRepositories(container: DependencyContainer): void {
  container.register(
    MessageRepo,
    { useClass: MessageRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("MessageRepo", {
    useFactory: (c) => c.resolve(MessageRepo),
  });
  container.register(
    ToolCallRecordRepo,
    { useClass: ToolCallRecordRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    TurnSnapshotRepo,
    { useClass: TurnSnapshotRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("ToolCallRecordRepo", {
    useFactory: (c) => c.resolve(ToolCallRecordRepo),
  });
  container.register(
    ThoughtSegmentRepo,
    { useClass: ThoughtSegmentRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("ThoughtSegmentRepo", {
    useFactory: (c) => c.resolve(ThoughtSegmentRepo),
  });
  container.register(
    HookExecutionRepo,
    { useClass: HookExecutionRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("HookExecutionRepo", {
    useFactory: (c) => c.resolve(HookExecutionRepo),
  });
  container.register("TurnSnapshotRepo", {
    useFactory: (c) => c.resolve(TurnSnapshotRepo),
  });
  container.register(
    TaskRepo,
    { useClass: TaskRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("TaskRepo", {
    useFactory: (c) => c.resolve(TaskRepo),
  });
}

/** Register planning repositories after cleanup and model-cache dependencies. */
export function registerAgentPlanningRepositories(container: DependencyContainer): void {
  container.register(
    PlanQuestionAnswersRepo,
    { useClass: PlanQuestionAnswersRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PlanQuestionAnswersRepo", {
    useFactory: (c) => c.resolve(PlanQuestionAnswersRepo),
  });
  container.register(
    PlanRepo,
    { useClass: PlanRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PlanRepo", {
    useFactory: (c) => c.resolve(PlanRepo),
  });
}
