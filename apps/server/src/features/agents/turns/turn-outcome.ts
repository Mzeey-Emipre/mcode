/**
 * How a turn ended. Replaces the bare `isError` boolean across the turn-end
 * paths so that a user cancellation and a crash are no longer conflated:
 *
 * - `completed` — the turn finished normally.
 * - `errored` — the turn was killed by a failure (provider error, crash).
 * - `cancelled` — the user stopped the turn.
 *
 * The distinction drives the status a still-running tool call inherits when the
 * turn ends: `completed`, `failed`, and `cancelled` respectively.
 */
export type TurnOutcome = "completed" | "errored" | "cancelled";
