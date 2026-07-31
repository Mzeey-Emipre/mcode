import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  TurnRuntimePhase,
  TurnRuntimeSnapshot,
} from "@mcode/contracts";

type TerminalPhase = Extract<TurnRuntimePhase, "completed" | "errored" | "cancelled">;

interface RuntimeState extends TurnRuntimeSnapshot {
  terminalized: boolean;
}

/** Owns one Mcode execution identity and lifecycle per thread. */
export class TurnRuntimeRegistry {
  private readonly states = new Map<string, RuntimeState>();

  /** Start a new Mcode turn and return its fresh execution identity. */
  start(threadId: string): TurnRuntimeSnapshot {
    const snapshot: RuntimeState = {
      threadId,
      turnExecutionId: randomUUID(),
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
    return [...this.states.values()].map((state) => this.copy(state));
  }

  /** Return active thread ids as a derived view, never as lifecycle authority. */
  runningThreadIds(): string[] {
    return [...this.states.values()]
      .filter((state) => state.phase === "running" || state.phase === "finalizing")
      .map((state) => state.threadId);
  }

  /** Normalize provider output to the current Mcode execution identity. */
  normalizeEvent(event: AgentEvent): AgentEvent | undefined {
    const current = this.states.get(event.threadId);
    if (event.type === "turnStarted") {
      const state = current?.phase === "running" && !current.terminalized
        ? current
        : this.start(event.threadId);
      return { ...event, turnExecutionId: state.turnExecutionId! };
    }
    if (!current || current.turnExecutionId === null || current.terminalized) return undefined;
    if (event.turnExecutionId && event.turnExecutionId !== current.turnExecutionId) return undefined;
    return { ...event, turnExecutionId: current.turnExecutionId };
  }

  /** Accept the first terminal signal for the active execution only. */
  terminalize(threadId: string, executionId: string, phase: TerminalPhase): boolean {
    const state = this.states.get(threadId);
    if (!state || state.terminalized || state.turnExecutionId !== executionId) return false;
    state.phase = phase;
    state.terminalized = true;
    return true;
  }

  /** Restore authoritative runtime state received during reconnect. */
  hydrate(snapshots: readonly TurnRuntimeSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.states.set(snapshot.threadId, {
        ...snapshot,
        terminalized: snapshot.phase !== "running" && snapshot.phase !== "finalizing",
      });
    }
  }

  /** Remove terminal state after its bounded retention period. */
  evict(threadId: string): void {
    const state = this.states.get(threadId);
    if (state && state.terminalized) this.states.delete(threadId);
  }

  private copy(state: RuntimeState): TurnRuntimeSnapshot {
    return {
      threadId: state.threadId,
      turnExecutionId: state.turnExecutionId,
      phase: state.phase,
    };
  }
}
