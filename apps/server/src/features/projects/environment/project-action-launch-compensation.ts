import type { PreparedTerminalCommandSession } from "../../terminal/backends/terminal-backend.js";
import type { ActiveProjectAction } from "./project-action-types.js";

/** Stops a launched terminal after later startup work fails and preserves both failures. */
export async function compensateFailedProjectActionLaunch(input: {
  readonly error: unknown;
  readonly session: PreparedTerminalCommandSession;
  readonly active: ActiveProjectAction | null;
  readonly onExit: (runId: string, exit: { readonly exitCode: number | null }) => void;
  readonly settleStart: () => void;
}): Promise<never> {
  const active = input.active;
  if (active?.state === "running") {
    active.stopping = true;
    input.session.onExit((exit) => input.onExit(active.run.runId, exit));
  }
  try {
    await input.session.stop();
  } catch (cleanupError) {
    input.settleStart();
    throw new AggregateError(
      [input.error, cleanupError],
      "Project Action launch and cleanup failed",
      { cause: input.error },
    );
  }
  input.settleStart();
  throw input.error;
}
