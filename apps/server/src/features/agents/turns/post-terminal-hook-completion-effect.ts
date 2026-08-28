import { inject, injectable } from "tsyringe";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";

import { broadcast } from "../../../application/transport/push.js";
import {
  HookExecutionRepo,
  type CreateHookExecutionInput,
} from "../events/persistence/hook-execution-repo.js";
import { TURN_FINALIZER, TurnFinalizer } from "./turn-finalizer.js";

/** Schedules durable hook completion records after their parent turn has materialized. */
@injectable()
export class PostTerminalHookCompletionEffect {
  constructor(
    @inject(HookExecutionRepo) private readonly hooks: HookExecutionRepo,
    @inject(TURN_FINALIZER) private readonly finalizer: TurnFinalizer,
  ) {}

  /** Persist and publish a late hook only after the terminal turn projection verifies. */
  schedule(
    threadId: string,
    hook: Omit<CreateHookExecutionInput, "messageId">,
    terminalProjection: Promise<boolean> | undefined,
  ): void {
    const persist = () => this.persist(threadId, hook);
    if (!terminalProjection) {
      persist();
      return;
    }
    void terminalProjection.then((persisted) => {
      if (persisted) persist();
    });
  }

  private persist(threadId: string, hook: Omit<CreateHookExecutionInput, "messageId">): void {
    const messageId = this.finalizer.getLastPersistedMessageId(threadId);
    if (!messageId) return;
    this.hooks.bulkCreate([{ ...hook, messageId }]);
    broadcast("agent.event", {
      type: AgentEventType.HookCompleted,
      threadId,
      hookName: hook.hookName,
      exitCode: 0,
      durationMs: hook.durationMs ?? 0,
      didBlock: hook.didBlock,
      persistedMessageId: messageId,
      persistedHookId: hook.id,
    } satisfies AgentEvent);
  }
}
