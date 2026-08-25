import { beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
  type WorkspaceEnvironmentActionRun,
} from "@mcode/contracts";
import { useProjectActionStore } from "../project-action-store";

function run(runId: string, createdAt: string): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "build",
    runId,
    revision: 0,
    terminalSessionId: `${runId}-terminal`,
    actionName: "Build",
    status: "running",
    snapshot: {
      platform: "windows",
      script: "bun run build",
      checkoutPath: "C:\\repo",
      terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
      environmentNames: ["PATH"],
    },
    createdAt,
    startedAt: createdAt,
    finishedAt: null,
    exitCode: null,
    transcript: "",
    transcriptTruncated: false,
  };
}

describe("Project Action renderer state", () => {
  beforeEach(() => {
    useProjectActionStore.setState({
      runsByThread: {},
      configurationEpochByWorkspace: {},
      updateEpochByThread: {},
      updateEpochByThreadAction: {},
      hydrationByThread: {},
    });
  });

  it("accepts a newer run from another client and rejects a delayed older run", () => {
    const older = run("run-1", "2026-08-22T12:00:00.000Z");
    const newer = run("run-2", "2026-08-22T12:01:00.000Z");
    const store = useProjectActionStore.getState();

    store.applyRun(older);
    store.applyRun(newer);
    store.applyRun(older);

    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.runId).toBe("run-2");
  });

  it("uses the run ID to order equally-timestamped replacement runs", () => {
    const store = useProjectActionStore.getState();

    store.applyRun(run("run-a", "2026-08-22T12:00:00.000Z"));
    store.applyRun(run("run-b", "2026-08-22T12:00:00.000Z"));

    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.runId).toBe("run-b");
  });

  it("retains a completed result until the owning Thread is deleted", () => {
    const completed = {
      ...run("run-1", "2026-08-22T12:00:00.000Z"),
      status: "completed" as const,
      revision: 1,
      finishedAt: "2026-08-22T12:00:01.000Z",
      exitCode: 0,
      transcript: "done",
    };
    const store = useProjectActionStore.getState();

    store.applyRun(completed);
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.status).toBe("completed");
    store.clearThread("thread-1");

    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toBeUndefined();
  });

  it("never regresses one finalized run to a delayed running update", () => {
    const completed = {
      ...run("run-1", "2026-08-22T12:00:00.000Z"),
      status: "completed" as const,
      finishedAt: "2026-08-22T12:00:01.000Z",
      exitCode: 0,
      transcript: "complete output",
    };
    const delayedRunning = {
      ...completed,
      revision: 2,
      status: "running" as const,
      finishedAt: null,
      exitCode: null,
      transcript: "",
    };
    const store = useProjectActionStore.getState();

    store.applyRun(completed);
    store.applyRun(delayedRunning);

    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build).toMatchObject({
      status: "completed",
      transcript: "complete output",
    });
  });

  it("replaces a Thread map with the authoritative Action list", () => {
    const pushed = { ...run("run-2", "2026-08-22T12:01:00.000Z"), revision: 1, transcript: "new output" };
    const delayedList = run("run-1", "2026-08-22T12:00:00.000Z");
    const store = useProjectActionStore.getState();

    store.applyRun(pushed);
    store.replaceRuns("thread-1", [delayedList]);

    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build).toMatchObject({
      runId: "run-1",
      transcript: "",
    });
  });

  it("removes a phantom retained slot omitted by the authoritative Action list", () => {
    const store = useProjectActionStore.getState();
    store.applyRun(run("run-build", "2026-08-22T12:00:00.000Z"));
    store.applyRun({ ...run("run-test", "2026-08-22T12:01:00.000Z"), actionId: "test", actionName: "Test" });

    store.replaceRuns("thread-1", [run("run-build", "2026-08-22T12:00:00.000Z")]);

    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toEqual({
      build: expect.objectContaining({ runId: "run-build" }),
    });
  });

  it("rejects a delayed capped transcript with the same byte length", () => {
    const current = {
      ...run("run-1", "2026-08-22T12:00:00.000Z"),
      revision: 2,
      transcript: "n".repeat(WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES),
      transcriptTruncated: true,
    };
    const delayed = {
      ...current,
      revision: 1,
      transcript: "o".repeat(WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES),
    };
    const store = useProjectActionStore.getState();

    store.applyRun(current);
    store.applyRun(delayed);

    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.transcript.slice(0, 1)).toBe("n");
  });

  it("releases invalidated hydration lifecycles after many cleared requests settle", () => {
    const store = useProjectActionStore.getState();
    for (let index = 0; index < 512; index += 1) {
      const threadId = `thread-${index}`;
      const generation = store.beginHydration(threadId);
      store.clearThread(threadId);
      store.hydrateRuns(threadId, [{ ...run(`run-${index}`, "2026-08-22T12:00:00.000Z"), threadId }], 0, generation);
      store.endHydration(threadId);
    }

    expect(useProjectActionStore.getState().hydrationByThread).toEqual({});
    expect(useProjectActionStore.getState().runsByThread).toEqual({});
  });
});
