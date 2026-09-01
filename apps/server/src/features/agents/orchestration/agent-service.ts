import { inject, injectable } from "tsyringe";
import type { AgentStopResult, Thread, TurnRuntimeSnapshot } from "@mcode/contracts";

import type { WorkspaceEnvironmentAutomaticSetupDispatch } from "../../projects/environment/workspace-environment-service.js";
import type { WorkspaceEnvironmentQueuedTurnSubmission } from "../turns/turn-admission-dispatch-coordinator.js";
import { TurnRuntimeController } from "./turn-runtime-controller.js";

export type { CreateAndSendCommand } from "../turns/thread-creation-coordinator.js";
export type { SendMessageCommand } from "../turns/turn-admission-dispatch-coordinator.js";
export type { AgentRuntimeAccess } from "./turn-runtime-controller.js";

/** Stable public facade for agent turn operations. */
@injectable()
export class AgentService {
  constructor(
    @inject(TurnRuntimeController) private readonly runtime: TurnRuntimeController,
  ) {}

  /** Send one admitted turn through its selected provider. */
  sendMessage(command: import("../turns/turn-admission-dispatch-coordinator.js").SendMessageCommand): Promise<void> {
    return this.runtime.sendMessage(command);
  }

  /** Create a thread and start its first turn when its lifecycle permits. */
  createAndSend(command: import("../turns/thread-creation-coordinator.js").CreateAndSendCommand): Promise<Thread & { runtimeSnapshot: TurnRuntimeSnapshot; warnings?: string[] }> {
    return this.runtime.createAndSend(command);
  }

  /** Start one automatic setup turn after its durable queue submission commits. */
  dispatchQueuedAutomaticTurn(submission: WorkspaceEnvironmentQueuedTurnSubmission): Promise<WorkspaceEnvironmentAutomaticSetupDispatch> {
    return this.runtime.dispatchQueuedAutomaticTurn(submission);
  }

  /** Stop one active turn. */
  stopSession(threadId: string): Promise<AgentStopResult> {
    return this.runtime.stopSession(threadId);
  }

  /** Stop and discard the provider session for a deleted thread. */
  teardownSession(threadId: string): Promise<void> {
    return this.runtime.teardownSession(threadId);
  }

  /** Read active runtime state for server-owned recovery and diagnostics. */
  runtimeAccess(): import("./turn-runtime-controller.js").AgentRuntimeAccess {
    return this.runtime.runtimeAccess();
  }

  /** Stop all active provider sessions during shutdown. */
  stopAll(): Promise<void> {
    return this.runtime.stopAll();
  }
}
