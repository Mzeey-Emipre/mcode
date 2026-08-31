import * as NodeCrypto from "node:crypto";
import type {
  AgentEvent,
  AgentEventType,
  TurnRuntimePhase,
  TurnRuntimeSnapshot,
} from "@mcode/contracts";

const TURN_SCOPED_EVENT_TYPES = new Set<AgentEventType>([
  "turnStarted", "message", "generatedAttachment", "toolUse", "toolResult",
  "turnComplete", "error", "ended", "compacting", "compactSummary",
  "modelFallback", "textDelta", "toolInputDelta", "toolProgress", "contextEstimate",
  "assistantMessageBoundary",
]);

/** Return whether provider event belongs to one originating logical turn. */
export function isTurnScopedEvent(event: AgentEvent): boolean {
  return TURN_SCOPED_EVENT_TYPES.has(event.type);
}

type TerminalPhase = Extract<TurnRuntimePhase, "completed" | "interrupted" | "errored" | "cancelled">;

interface RuntimeState extends TurnRuntimeSnapshot {
  terminalized: boolean;
  terminalizedAt?: number;
}

const MAX_TERMINAL_RETAINED = 128;
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

/** Owns one Mcode execution identity and lifecycle per thread. */
export class TurnRuntimeRegistry {
  private readonly states = new Map<string, RuntimeState>();

  /** Start a new Mcode turn and return its fresh execution identity. */
  start(threadId: string): TurnRuntimeSnapshot {
    const snapshot: RuntimeState = {
      threadId,
      turnExecutionId: NodeCrypto.randomUUID(),
      phase: "running",
      terminalized: false,
    };
    this.states.set(threadId, snapshot);
    return this.copy(snapshot);
  }

  /** Return authoritative state for one thread, if known. */
  snapshot(threadId: string): TurnRuntimeSnapshot | undefined {
    const state = this.states.get(threadId);
    return state ? this.copy(state) : undefined;
  }

  /** Return snapshots for reconnect hydration. */
  snapshots(): TurnRuntimeSnapshot[] {
    this.sweepTerminalState();
    return [...this.states.values()].map((state) => this.copy(state));
  }

  /** Return active thread ids as a derived view, never as lifecycle authority. */
  runningThreadIds(): string[] {
    return [...this.states.values()]
      .filter((state) => state.phase === "running" || state.phase === "finalizing")
      .map((state) => state.threadId);
  }

  /** Normalize provider output only when provider supplied its source identity. */
  normalizeEvent(event: AgentEvent): AgentEvent | undefined {
    if (!isTurnScopedEvent(event)) return event;
    const current = this.states.get(event.threadId);
    return event.type === "turnStarted"
      ? this.normalizeTurnStarted(event, current)
      : this.normalizeTurnEvent(event, current);
  }

  /** Accept the first terminal signal for the active execution only. */
  terminalize(threadId: string, executionId: string, phase: TerminalPhase): boolean {
    const state = this.states.get(threadId);
    if (!state || state.terminalized || state.turnExecutionId !== executionId) return false;
    state.phase = phase;
    state.terminalized = true;
    state.terminalizedAt = Date.now();
    return true;
  }

  /** Restore authoritative runtime state received during reconnect. */
  hydrate(snapshots: readonly TurnRuntimeSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.states.set(snapshot.threadId, {
        ...snapshot,
        terminalized: snapshot.phase !== "running" && snapshot.phase !== "finalizing",
        ...(snapshot.phase !== "running" && snapshot.phase !== "finalizing" ? { terminalizedAt: Date.now() } : {}),
      });
    }
  }

  /** Remove terminal state after its bounded retention period. */
  evict(threadId: string): void {
    const state = this.states.get(threadId);
    if (state && state.terminalized) this.states.delete(threadId);
  }

  private sweepTerminalState(): void {
    const now = Date.now();
    const terminal = [...this.states.values()]
      .filter((state) => state.terminalized)
      .sort((a, b) => (a.terminalizedAt ?? 0) - (b.terminalizedAt ?? 0));
    for (const state of terminal) {
      if ((state.terminalizedAt ?? now) + TERMINAL_RETENTION_MS <= now) {
        this.states.delete(state.threadId);
      }
    }
    const remaining = terminal.filter((state) => this.states.has(state.threadId));
    for (const state of remaining.slice(0, Math.max(0, remaining.length - MAX_TERMINAL_RETAINED))) {
      this.states.delete(state.threadId);
    }
  }

  private copy(state: RuntimeState): TurnRuntimeSnapshot {
    return {
      threadId: state.threadId,
      turnExecutionId: state.turnExecutionId,
      phase: state.phase,
    };
  }

  private normalizeTurnStarted(event: AgentEvent, current: RuntimeState | undefined): AgentEvent | undefined {
    if (!event.turnExecutionId) return undefined;
    if (current?.terminalized && current.phase === "completed") {
      this.states.set(event.threadId, {
        threadId: event.threadId,
        turnExecutionId: event.turnExecutionId,
        phase: "running",
        terminalized: false,
      });
      return event;
    }
    return current && current.turnExecutionId === event.turnExecutionId && !current.terminalized
      ? event
      : undefined;
  }

  private normalizeTurnEvent(event: AgentEvent, current: RuntimeState | undefined): AgentEvent | undefined {
    if (this.isDuplicateCompletion(event, current)) return event;
    if (!current || current.turnExecutionId === null || current.terminalized || !event.turnExecutionId) {
      return undefined;
    }
    return event.turnExecutionId === current.turnExecutionId ? event : undefined;
  }

  private isDuplicateCompletion(event: AgentEvent, current: RuntimeState | undefined): boolean {
    return event.type === "turnComplete"
      && current?.terminalized === true
      && current.phase === "completed"
      && event.turnExecutionId === current.turnExecutionId;
  }
}
