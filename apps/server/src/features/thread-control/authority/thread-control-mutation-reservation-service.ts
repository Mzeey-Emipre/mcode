import * as NodeCrypto from "node:crypto";
import { injectable } from "tsyringe";

/** Lifecycle states for one per-thread mutation reservation. */
export type ThreadMutationReservationState =
  | "pendingApproval"
  | "activeTurn"
  | "stopping"
  | "completing"
  | "reopening"
  | "cleaning";

interface Reservation {
  token: string;
  state: ThreadMutationReservationState;
}

/** Shared atomic per-thread gate used by composer and thread-control mutations. */
@injectable()
export class ThreadControlMutationReservationService {
  private readonly reservations = new Map<string, Reservation>();

  /** Reserve an idle thread and return its opaque mutation token. */
  reserve(
    threadId: string,
    state: ThreadMutationReservationState,
    token = NodeCrypto.randomUUID(),
  ): string | null {
    if (this.reservations.has(threadId)) return null;
    this.reservations.set(threadId, { token, state });
    return token;
  }

  /** Rehydrate a durable pending approval after a process restart. */
  rehydrate(
    threadId: string,
    token: string,
    state: "pendingApproval" = "pendingApproval",
  ): boolean {
    const existing = this.reservations.get(threadId);
    if (existing) return existing.token === token && existing.state === state;
    this.reservations.set(threadId, { token, state });
    return true;
  }

  /** Replace a provisional token with the durable approval identity. */
  replaceToken(threadId: string, currentToken: string, nextToken: string): boolean {
    const existing = this.reservations.get(threadId);
    if (!existing || existing.token !== currentToken) return false;
    existing.token = nextToken;
    return true;
  }

  /** Transition a reservation only when the caller still owns its token. */
  transition(
    threadId: string,
    token: string,
    from: ThreadMutationReservationState,
    to: ThreadMutationReservationState,
  ): boolean {
    const existing = this.reservations.get(threadId);
    if (!existing || existing.token !== token || existing.state !== from) return false;
    existing.state = to;
    return true;
  }

  /** Check whether a token is the current reservation for a thread. */
  owns(threadId: string, token: string, state?: ThreadMutationReservationState): boolean {
    const existing = this.reservations.get(threadId);
    return existing?.token === token && (state === undefined || existing.state === state);
  }

  /** Invoke a dispatch only while the caller still owns the current reservation. */
  runIfOwned<T>(
    threadId: string,
    token: string,
    state: ThreadMutationReservationState,
    dispatch: () => T,
  ): T | undefined {
    if (!this.owns(threadId, token, state)) return undefined;
    return dispatch();
  }

  /** Return the current reservation state for diagnostics and policy decisions. */
  get(threadId: string): { token: string; state: ThreadMutationReservationState } | undefined {
    const existing = this.reservations.get(threadId);
    return existing ? { ...existing } : undefined;
  }

  /** Release a reservation after denial, failure, cancellation, or completion. */
  release(threadId: string, token: string): boolean {
    const existing = this.reservations.get(threadId);
    if (!existing || existing.token !== token) return false;
    this.reservations.delete(threadId);
    return true;
  }
}
