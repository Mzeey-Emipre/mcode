import { beforeEach, describe, expect, it } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "./planStore";

const THREAD = "thread-plan-preview";

function plan(version: number): PlanRecord {
  return {
    id: `plan-${version}`,
    threadId: THREAD,
    messageId: `message-${version}`,
    version,
    title: `Plan ${version}`,
    contentMd: "## Plan",
    sectionsJson: null,
    changeSummary: null,
    status: "draft",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("plan live preview state", () => {
  beforeEach(() => {
    usePlanStore.setState({
      plansByThread: {},
      activeVersionByThread: {},
      generatingThreads: new Set(),
      livePreviewByThread: {},
      dismissedPreviewVersionsByThread: {},
    });
  });

  it("does not create a preview when a plan is only added to saved state", () => {
    usePlanStore.getState().addPlan(THREAD, plan(1));

    expect(usePlanStore.getState().livePreviewByThread[THREAD]).toBeUndefined();
  });

  it("dismisses only the visible version and allows a newer version to preview", () => {
    usePlanStore.getState().showLivePreview(THREAD, plan(1));
    usePlanStore.getState().dismissLivePreview(THREAD, 1);
    usePlanStore.getState().showLivePreview(THREAD, plan(1));

    expect(usePlanStore.getState().livePreviewByThread[THREAD]).toBeUndefined();

    usePlanStore.getState().showLivePreview(THREAD, plan(2));

    expect(usePlanStore.getState().livePreviewByThread[THREAD]).toMatchObject({
      version: 2,
      title: "Plan 2",
    });
  });
});
