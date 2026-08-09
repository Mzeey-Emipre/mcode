import type { TerminalRetryClass, TerminalSessionState } from "./terminal.js";

const freezeTable = <const Table extends ReadonlyArray<Readonly<Record<string, unknown>>>>(
  table: Table,
): Table => {
  for (const row of table) Object.freeze(row);
  return Object.freeze(table);
};

/** One immutable state-machine transition. */
export interface TerminalTransition<State extends string, Event extends string> {
  readonly from: State | null;
  readonly event: Event;
  readonly to: State | null;
  readonly retry?: TerminalRetryClass;
}

/** Boot-selection states for Terminal v1. */
export type TerminalBootState =
  | "starting"
  | "modern-selected"
  | "legacy-selected"
  | "modern-recovering"
  | "modern-unhealthy"
  | "stopped";

/** Frozen boot-selection transition table. */
export const TERMINAL_BOOT_TRANSITIONS = freezeTable([
  { from: "starting", event: "modern-ready", to: "modern-selected" },
  { from: "starting", event: "startup-failed", to: "legacy-selected" },
  { from: "starting", event: "create-requested", to: "starting", retry: "SAFE_RETRY" },
  { from: "modern-selected", event: "host-healthy", to: "modern-selected" },
  { from: "modern-selected", event: "host-unhealthy", to: "modern-recovering" },
  { from: "modern-recovering", event: "replacement-ready", to: "modern-selected" },
  { from: "modern-recovering", event: "replacement-failed", to: "modern-unhealthy", retry: "RESTART" },
  { from: "modern-selected", event: "shutdown", to: "stopped" },
  { from: "legacy-selected", event: "shutdown", to: "stopped" },
  { from: "modern-recovering", event: "shutdown", to: "stopped" },
  { from: "modern-unhealthy", event: "shutdown", to: "stopped" },
  { from: "starting", event: "shutdown", to: "stopped" },
] as const satisfies ReadonlyArray<TerminalTransition<TerminalBootState, string>>);

/** Frozen shell-session lifecycle transition table. */
export const TERMINAL_SESSION_TRANSITIONS = freezeTable([
  { from: null, event: "create-accepted", to: "starting" },
  { from: "starting", event: "host-running", to: "running" },
  { from: "starting", event: "create-failed", to: null, retry: "NEW_SESSION" },
  { from: "running", event: "input-accepted", to: "running" },
  { from: "running", event: "resize-accepted", to: "running" },
  { from: "running", event: "close-requested", to: "exiting" },
  { from: "running", event: "natural-exit", to: "exiting" },
  { from: "running", event: "host-crash", to: "failed", retry: "NEW_SESSION" },
  { from: "running", event: "containment-lost", to: "failed", retry: "NEW_SESSION" },
  { from: "exiting", event: "exit-flushed", to: "exited" },
  { from: "exiting", event: "exit-flush-failed", to: "failed", retry: "REATTACH" },
  { from: "exited", event: "explicit-close", to: null },
  { from: "failed", event: "explicit-close", to: null },
] as const satisfies ReadonlyArray<TerminalTransition<TerminalSessionState, string>>);

/** Resolves a shell-session transition or rejects an event that the contract forbids. */
export function resolveTerminalSessionTransition(
  state: TerminalSessionState | null,
  event: (typeof TERMINAL_SESSION_TRANSITIONS)[number]["event"],
): TerminalSessionState | null {
  const transition = TERMINAL_SESSION_TRANSITIONS.find(
    (candidate) => candidate.from === state && candidate.event === event,
  );
  if (!transition) throw new Error(`Invalid Terminal session transition: ${state ?? "none"} + ${event}`);
  return transition.to;
}

/** Host health states for Terminal v1. */
export type TerminalHostHealthState = "starting" | "healthy" | "degraded" | "unhealthy";

/** Frozen PTY host-health transition table. */
export const TERMINAL_HOST_HEALTH_TRANSITIONS = freezeTable([
  { from: "starting", event: "ready-heartbeat", to: "healthy" },
  { from: "healthy", event: "heartbeat-missed", to: "degraded" },
  { from: "degraded", event: "probe-succeeded", to: "healthy" },
  { from: "degraded", event: "probe-failed", to: "unhealthy" },
  { from: "healthy", event: "rss-limit-sustained", to: "unhealthy" },
  { from: "unhealthy", event: "replacement-ready", to: "healthy" },
  { from: "starting", event: "process-exited", to: "unhealthy" },
  { from: "healthy", event: "process-exited", to: "unhealthy" },
  { from: "degraded", event: "process-exited", to: "unhealthy" },
  { from: "starting", event: "watchdog-paused", to: "starting" },
  { from: "healthy", event: "watchdog-paused", to: "healthy" },
  { from: "degraded", event: "watchdog-paused", to: "degraded" },
  { from: "unhealthy", event: "watchdog-paused", to: "unhealthy" },
] as const satisfies ReadonlyArray<TerminalTransition<TerminalHostHealthState, string>>);

/** Terminal attachment lease states. */
export type TerminalAttachmentState = "attaching" | "attached";

/** Frozen attachment-lease transition table. */
export const TERMINAL_ATTACHMENT_TRANSITIONS = freezeTable([
  { from: null, event: "attach-validated", to: "attaching" },
  { from: "attaching", event: "hydration-complete", to: "attached" },
  { from: "attaching", event: "hydration-failed", to: null, retry: "REATTACH" },
  { from: "attached", event: "detach", to: null },
  { from: "attached", event: "ack-stalled", to: null, retry: "REATTACH" },
] as const satisfies ReadonlyArray<TerminalTransition<TerminalAttachmentState, string>>);

/** Frozen hydration decisions for retained output and checkpoints. */
export const TERMINAL_HYDRATION_DECISIONS = freezeTable([
  { condition: "requested-output-contiguous", mode: "delta", retry: null },
  { condition: "checkpoint-valid-and-tail-contiguous", mode: "checkpoint-delta", retry: null },
  { condition: "retention-or-checkpoint-gap", mode: "reset-tail-gap", retry: "REATTACH" },
  { condition: "host-generation-mismatch", mode: null, retry: "NEW_SESSION" },
] as const);

/** Tombstone and replacement states. */
export type TerminalTombstoneState = "retained" | "replacement-starting";

/** Frozen tombstone and replacement transition table. */
export const TERMINAL_TOMBSTONE_TRANSITIONS = freezeTable([
  { from: null, event: "session-exited-or-failed", to: "retained" },
  { from: "retained", event: "replacement-requested", to: "replacement-starting" },
  { from: "replacement-starting", event: "replacement-running", to: null },
  { from: "replacement-starting", event: "replacement-failed", to: "retained", retry: "NEW_SESSION" },
  { from: "retained", event: "explicit-close", to: null },
] as const satisfies ReadonlyArray<TerminalTransition<TerminalTombstoneState, string>>);

/** Checkpoint upload states. */
export type TerminalCheckpointState = "open" | "installed" | "aborted";

/** Frozen checkpoint-upload transition table. */
export const TERMINAL_CHECKPOINT_TRANSITIONS = freezeTable([
  { from: null, event: "begin-validated", to: "open" },
  { from: "open", event: "chunk-accepted", to: "open" },
  { from: "open", event: "complete-valid", to: "installed" },
  { from: "open", event: "missing-chunk", to: "aborted", retry: "REATTACH" },
  { from: "open", event: "hash-size-mismatch", to: "aborted", retry: "REATTACH" },
  { from: "open", event: "timeout-disconnect-invalid", to: "aborted", retry: "REATTACH" },
  { from: "installed", event: "stale-upload", to: "installed" },
] as const satisfies ReadonlyArray<TerminalTransition<TerminalCheckpointState, string>>);

/** Normative actor-level Terminal v1 sequence traces. */
export const TERMINAL_SEQUENCE_TRACES = {
  create: ["session.create", "scope-profile-capacity.validate", "host.create", "containment.running", "snapshot.running", "attach", "hydrate"],
  attach: ["attach", "prior-epoch.revoke", "descriptor.input-disabled", "hydration.chunks", "hydration.complete", "output.ack", "input.enable"],
  hide: ["detach.hide", "writes.settle", "checkpoint.begin", "checkpoint.chunks", "checkpoint.complete-authority", "delivery.pause", "host.output-to-replay"],
  switch: ["detach.switch", "session.select", "attach", "hydration.choose", "renderer.hydrate-hidden", "anchor.restore", "reveal"],
  reconnectDelta: ["session.list", "attach", "delta", "renderer.write", "output.ack", "attached"],
  reconnectCheckpoint: ["attach.checkpoint", "checkpoint.validate", "checkpoint-delta", "renderer.restore", "output.ack", "reveal"],
  reconnectGap: ["attach.evicted", "gap", "retained-tail", "renderer.reset", "gap.display", "hydrate.complete"],
  headlessClose: ["session.close", "close-barrier", "host.close", "host.exit", "replay.flush", "tombstone"],
  naturalExit: ["host.exit", "session.exiting", "output.flush", "exit-barrier", "renderer.write-or-gap", "session.exited"],
  hostCrash: ["watchdog.deadline", "host.unhealthy", "sessions.failed", "cleanup.reap", "replacement.once", "no-live-legacy-switch"],
  settingsChange: ["preferences.update", "settings.validate", "live-safe.apply", "replay.evict-with-gap", "no-pty-restart"],
  profileDeletion: ["profile.delete", "references.check", "profile-in-use-or-atomic-delete", "launch-snapshot.unchanged"],
  workspaceReset: ["workspace-preference.reset", "override.delete", "sessions.unchanged", "future-global-default"],
  startupFallback: ["modern.start", "monotonic-five-seconds", "health.fail", "legacy.select-for-boot", "persistent-notice"],
  restartWithLegacy: ["modern-recovery.exhausted", "backend-restart-required", "user.restart", "new-boot-legacy-selection", "no-session-migration"],
} as const;
