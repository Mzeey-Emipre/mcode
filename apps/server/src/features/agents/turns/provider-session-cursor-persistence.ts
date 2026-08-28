import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type { AgentEvent, ProviderId } from "@mcode/contracts";

import {
  PARENT_TURN_DURABILITY,
  type ParentTurnDurability,
} from "./parent-turn-durability.js";
import {
  TURN_RUNTIME_PERSISTENCE,
  type TurnRuntimePersistence,
} from "./turn-runtime-persistence.js";

/** Persists provider-native session cursor updates with their durable provenance. */
@injectable()
export class ProviderSessionCursorPersistence {
  constructor(
    @inject(TURN_RUNTIME_PERSISTENCE) private readonly runtime: TurnRuntimePersistence,
    @inject(PARENT_TURN_DURABILITY) private readonly parentTurns: ParentTurnDurability,
  ) {}

  /** Apply a normalized provider system event when it carries session state. */
  apply(providerId: ProviderId, event: Extract<AgentEvent, { type: "system" }>, executionId?: string): void {
    if (event.subtype.startsWith("sdk_session_id:")) {
      this.save(providerId, event.threadId, event.subtype.slice("sdk_session_id:".length), executionId);
      return;
    }
    if (event.subtype === "sdk_session_invalidated") this.clear(event.threadId);
  }

  /** Remove a stale cursor before a retry starts a fresh provider session. */
  clearForRetry(threadId: string): void {
    this.clear(threadId);
  }

  private save(providerId: ProviderId, threadId: string, cursor: string, executionId?: string): void {
    if (!cursor) return;
    try {
      this.runtime.saveProviderCursor(threadId, cursor);
      if (!executionId) return;
      this.parentTurns.recordNativeCursor(executionId, {
        providerId,
        scope: nativeCursorScope(providerId),
        value: cursor,
        provenance: "native",
      });
    } catch (error) {
      logger.warn("Failed to persist provider session cursor", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clear(threadId: string): void {
    try {
      this.runtime.clearProviderCursor(threadId);
    } catch (error) {
      logger.warn("Failed to clear provider session cursor", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function nativeCursorScope(providerId: ProviderId): "thread" | "session" {
  return providerId === "codex" ? "thread" : "session";
}
