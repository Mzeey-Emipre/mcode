import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import type { PreparedTerminalCommandSession } from "../../terminal/backends/terminal-backend.js";

/** Active terminal state owned by one Project Action slot. */
export interface ActiveProjectAction {
  state: "running" | "pending-finalization";
  readonly threadId: string;
  readonly actionId: string;
  readonly session: PreparedTerminalCommandSession;
  run: WorkspaceEnvironmentActionRun;
  pendingFinalization: WorkspaceEnvironmentActionRun | null;
  outputRemainder: Uint8Array;
  stopping: boolean;
}

/** Reserved Project Action slot while environment resolution or launch is in progress. */
export interface StartingProjectAction {
  readonly state: "starting";
  readonly threadId: string;
  readonly actionId: string;
  readonly settled: Promise<ActiveProjectAction | null>;
  resolve(active: ActiveProjectAction | null): void;
}

/** Current mutable state for one Project Action slot. */
export type ProjectActionSlotState = ActiveProjectAction | StartingProjectAction;

/** Creates the reservation that excludes one Project Action slot during startup. */
export function createStartingProjectAction(threadId: string, actionId: string): StartingProjectAction {
  let resolve: (active: ActiveProjectAction | null) => void = () => undefined;
  const settled = new Promise<ActiveProjectAction | null>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { state: "starting", threadId, actionId, settled, resolve };
}
