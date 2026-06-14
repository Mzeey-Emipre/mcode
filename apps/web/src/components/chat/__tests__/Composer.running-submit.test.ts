import { describe, expect, it, beforeEach } from "vitest";
import {
  isThreadRunningForSubmit,
  shouldQueueActiveThreadSubmit,
} from "../Composer";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";

describe("Composer submit running-state", () => {
  beforeEach(() => {
    resetThreadStoreForTests({ runningThreadIds: new Set() });
  });

  it("treats a thread as running when the store has advanced before render props", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1"]) });

    expect(isThreadRunningForSubmit("t-1", false)).toBe(true);
  });

  it("keeps rendered running state authoritative while the store catches up", () => {
    expect(isThreadRunningForSubmit("t-1", true)).toBe(true);
  });

  it("does not mark a missing thread as running", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1"]) });

    expect(isThreadRunningForSubmit(undefined, false)).toBe(false);
  });

  it("queues if the thread becomes running after the first submit check", () => {
    expect(
      shouldQueueActiveThreadSubmit("t-1", false, null, false, "follow-up"),
    ).toBe(false);

    useThreadStore.setState({ runningThreadIds: new Set(["t-1"]) });

    expect(
      shouldQueueActiveThreadSubmit("t-1", false, null, false, "follow-up"),
    ).toBe(true);
  });

  it("does not queue goal control commands while a thread is running", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1"]) });

    expect(
      shouldQueueActiveThreadSubmit("t-1", false, null, false, "/goal clear"),
    ).toBe(false);
  });
});
