import type {
  WorkspaceEnvironmentActionLaunchSnapshot,
  WorkspaceEnvironmentActionRun,
  WorkspaceEnvironmentPlatform,
} from "@mcode/contracts";
import type { PreparedTerminalCommandSession } from "../../terminal/backends/terminal-backend.js";

/** Builds immutable retained Project Action runs with monotonic timestamps. */
export class ProjectActionRunFactory {
  private lastTimestampMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => Date,
    private readonly createRunId: () => string,
    private readonly platform: () => WorkspaceEnvironmentPlatform,
  ) {}

  /** Creates a retained unavailable Action result. */
  createUnavailable(input: ProjectActionRunInput): WorkspaceEnvironmentActionRun {
    const timestamp = this.timestamp();
    return this.base(input, {
      terminalSessionId: null,
      status: "unavailable",
      createdAt: timestamp,
      startedAt: null,
      finishedAt: timestamp,
      exitCode: null,
      transcript: "",
      transcriptTruncated: false,
    });
  }

  /** Creates a retained failed Action result before terminal launch. */
  createFailed(input: ProjectActionFailedRunInput): WorkspaceEnvironmentActionRun {
    const timestamp = this.timestamp();
    return this.base({ ...input, snapshot: input.snapshot ?? unavailableSnapshot(input.script, this.platform()) }, {
      terminalSessionId: null,
      status: "failed",
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      exitCode: null,
      transcript: "",
      transcriptTruncated: false,
    });
  }

  /** Creates a retained Action result that awaits shared-command approval. */
  createAwaitingApproval(input: ProjectActionRunInput): WorkspaceEnvironmentActionRun {
    const timestamp = this.timestamp();
    return this.base(input, {
      terminalSessionId: null,
      status: "awaiting-approval",
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      transcript: "",
      transcriptTruncated: false,
    });
  }

  /** Creates the retained running run for one launched terminal session. */
  createActive(input: ProjectActionActiveRunInput): WorkspaceEnvironmentActionRun {
    const timestamp = this.timestamp();
    return {
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      actionId: input.actionId,
      runId: this.createRunId(),
      revision: 0,
      terminalSessionId: input.session.terminalSessionId,
      actionName: input.actionName,
      status: "running",
      snapshot: input.session.snapshot,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
      exitCode: null,
      transcript: "",
      transcriptTruncated: false,
    };
  }

  /** Returns the next strictly monotonic lifecycle timestamp. */
  timestamp(): string {
    const nextMs = Math.max(this.now().getTime(), this.lastTimestampMs + 1);
    this.lastTimestampMs = nextMs;
    return new Date(nextMs).toISOString();
  }

  private base(
    input: ProjectActionRunInput,
    values: Omit<WorkspaceEnvironmentActionRun, "threadId" | "workspaceId" | "actionId" | "runId" | "revision" | "actionName" | "snapshot">,
  ): WorkspaceEnvironmentActionRun {
    return {
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      actionId: input.actionId,
      runId: this.createRunId(),
      revision: 0,
      actionName: input.actionName,
      snapshot: input.snapshot,
      ...values,
    };
  }
}

/** Shared facts for one retained Project Action run. */
export interface ProjectActionRunInput {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly actionId: string;
  readonly actionName: string;
  readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
}

/** Facts for a failed Action run before a terminal session exists. */
export interface ProjectActionFailedRunInput extends Omit<ProjectActionRunInput, "snapshot"> {
  readonly script: string | null;
  readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot | null;
}

/** Facts for a running Action terminal session. */
export interface ProjectActionActiveRunInput {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly actionId: string;
  readonly actionName: string;
  readonly session: PreparedTerminalCommandSession;
}

function unavailableSnapshot(
  script: string | null,
  platform: WorkspaceEnvironmentPlatform,
): WorkspaceEnvironmentActionLaunchSnapshot {
  return {
    platform,
    script,
    checkoutPath: null,
    terminal: null,
    environmentNames: [],
  };
}
