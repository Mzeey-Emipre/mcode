import { logger } from "@mcode/shared";
import {
  WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
  type WorkspaceEnvironmentActionRun,
} from "@mcode/contracts";
import type { ProjectActionRunRepo } from "./persistence/project-action-run-repo.js";
import type { ProjectActionRunPublisher } from "./project-action-run-publisher.js";
import type { ActiveProjectAction, ProjectActionSlotState } from "./project-action-types.js";

/** Persists Project Action transcript and finalization transitions for active slots. */
export class ProjectActionRunLifecycle {
  constructor(
    private readonly runs: Pick<ProjectActionRunRepo, "updateIfCurrent">,
    private readonly active: Map<string, ProjectActionSlotState>,
    private readonly publisher: Pick<ProjectActionRunPublisher, "publish">,
    private readonly timestamp: () => string,
  ) {}

  /** Retains bounded terminal output and preserves it after transient write failure. */
  recordOutput(slot: string, runId: string, data: Uint8Array): void {
    const active = this.runningSlot(slot, runId);
    if (!active) return;
    const output = consumeCompleteOutput(active, data);
    if (output === null) return;
    appendOutput(active, output);
    this.persistOutput(active, runId);
  }

  /** Maps a terminal exit into one retained final Action run. */
  finish(slot: string, runId: string, exitCode: number | null): void {
    const active = this.runningSlot(slot, runId);
    if (!active) return;
    flushOutputRemainder(active);
    const finalRun = finalRunFor(active, exitCode, this.timestamp());
    active.run = finalRun;
    active.pendingFinalization = finalRun;
    active.state = "pending-finalization";
    this.retryPendingFinalization(slot, active);
  }

  /** Retries the one retained final run until the durable slot update succeeds. */
  retryPendingFinalization(slot: string, active: ActiveProjectAction): void {
    const finalRun = active.pendingFinalization;
    if (active.state !== "pending-finalization" || !finalRun) return;
    const persisted = this.persistFinalization(active, finalRun);
    if (persisted === null || this.active.get(slot) !== active) return;
    this.active.delete(slot);
    if (persisted) this.publisher.publish(finalRun);
  }

  private runningSlot(slot: string, runId: string): ActiveProjectAction | null {
    const active = this.active.get(slot);
    if (!active || active.state !== "running" || active.run.runId !== runId) return null;
    return active;
  }

  private persistOutput(active: ActiveProjectAction, runId: string): void {
    try {
      if (this.runs.updateIfCurrent(active.run)) this.publisher.publish(active.run);
    } catch (error) {
      logger.warn("Project Action output persistence failed; retaining output for the next durable update", {
        threadId: active.threadId,
        actionId: active.actionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persistFinalization(
    active: ActiveProjectAction,
    finalRun: WorkspaceEnvironmentActionRun,
  ): boolean | null {
    try {
      return this.runs.updateIfCurrent(finalRun);
    } catch (error) {
      logger.warn("Project Action finalization persistence failed; retaining the slot for retry", {
        threadId: active.threadId,
        actionId: active.actionId,
        runId: finalRun.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function finalRunFor(
  active: ActiveProjectAction,
  exitCode: number | null,
  finishedAt: string,
): WorkspaceEnvironmentActionRun {
  const status = active.stopping ? "interrupted" : exitCode === 0 ? "completed" : "failed";
  return {
    ...active.run,
    revision: active.run.revision + 1,
    status,
    finishedAt,
    exitCode: status === "interrupted" ? null : exitCode,
  };
}

function appendTranscript(
  current: string,
  alreadyTruncated: boolean,
  output: string,
): Pick<WorkspaceEnvironmentActionRun, "transcript" | "transcriptTruncated"> {
  const combined = Buffer.concat([Buffer.from(current, "utf8"), Buffer.from(output, "utf8")]);
  if (combined.byteLength <= WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES) {
    return { transcript: combined.toString("utf8"), transcriptTruncated: alreadyTruncated };
  }
  const transcript = boundedUtf8Suffix(combined);
  return {
    transcript,
    transcriptTruncated: true,
  };
}

function consumeCompleteOutput(active: ActiveProjectAction, data: Uint8Array): string | null {
  const output = Buffer.concat([Buffer.from(active.outputRemainder), Buffer.from(data)]);
  const remainderLength = trailingIncompleteUtf8ByteLength(output);
  const complete = output.subarray(0, output.byteLength - remainderLength);
  active.outputRemainder = output.subarray(output.byteLength - remainderLength);
  return complete.byteLength === 0 ? null : complete.toString("utf8");
}

function flushOutputRemainder(active: ActiveProjectAction): void {
  if (active.outputRemainder.byteLength === 0) return;
  const output = Buffer.from(active.outputRemainder).toString("utf8");
  active.outputRemainder = new Uint8Array();
  appendOutput(active, output);
}

function appendOutput(active: ActiveProjectAction, output: string): void {
  const transcript = appendTranscript(active.run.transcript, active.run.transcriptTruncated, output);
  active.run = { ...active.run, ...transcript, revision: active.run.revision + 1 };
}

function boundedUtf8Suffix(bytes: Buffer): string {
  const boundary = utf8BoundaryAtOrAfter(
    bytes,
    bytes.byteLength - WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
  );
  return bytes.subarray(boundary).toString("utf8");
}

function trailingIncompleteUtf8ByteLength(bytes: Uint8Array): number {
  let index = bytes.byteLength - 1;
  while (index >= 0 && isUtf8ContinuationByte(bytes[index])) index -= 1;
  if (index < 0) return 0;
  const expectedLength = utf8CodePointByteLength(bytes[index]);
  const actualLength = bytes.byteLength - index;
  return expectedLength > actualLength ? actualLength : 0;
}

function utf8CodePointByteLength(value: number): number {
  if (value >= 0b1100_0010 && value <= 0b1101_1111) return 2;
  if (value >= 0b1110_0000 && value <= 0b1110_1111) return 3;
  if (value >= 0b1111_0000 && value <= 0b1111_0100) return 4;
  return 1;
}

function utf8BoundaryAtOrAfter(bytes: Uint8Array, start: number): number {
  let boundary = Math.max(0, start);
  while (boundary < bytes.byteLength && isUtf8ContinuationByte(bytes[boundary])) boundary += 1;
  return boundary;
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}
