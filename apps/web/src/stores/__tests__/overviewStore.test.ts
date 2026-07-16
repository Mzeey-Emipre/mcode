import { beforeEach, describe, expect, it } from "vitest";
import { useOverviewStore } from "../overviewStore";

describe("overviewStore open request", () => {
  beforeEach(() => {
    useOverviewStore.setState({ reserveSpace: false, requestedThreadId: null });
  });

  it("keeps the request until the matching thread consumes it", () => {
    useOverviewStore.getState().requestOpen("thread-review");
    useOverviewStore.getState().consumeOpenRequest("other-thread");
    expect(useOverviewStore.getState().requestedThreadId).toBe("thread-review");

    useOverviewStore.getState().consumeOpenRequest("thread-review");
    expect(useOverviewStore.getState().requestedThreadId).toBeNull();
  });
});
