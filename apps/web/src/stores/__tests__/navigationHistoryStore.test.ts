import { beforeEach, describe, expect, it } from "vitest";
import {
  NAVIGATION_HISTORY_LIMIT,
  useNavigationHistoryStore,
  type NavigationLocation,
} from "../navigationHistoryStore";

const valid = () => true;

describe("navigationHistoryStore", () => {
  beforeEach(() => useNavigationHistoryStore.getState().reset());

  it("coalesces duplicate locations and clears forward history after direct navigation", () => {
    const history = useNavigationHistoryStore.getState();
    const first: NavigationLocation = { kind: "newThread", workspaceId: "one" };
    const second: NavigationLocation = {
      kind: "thread",
      workspaceId: "one",
      threadId: "two",
    };
    history.record(first);
    history.record(first);
    history.record(second);

    expect(useNavigationHistoryStore.getState().entries).toHaveLength(2);
    expect(history.back(valid)).toEqual(first);
    history.record(first);
    history.record({ kind: "settings", workspaceId: "one", section: "model" });

    expect(useNavigationHistoryStore.getState().entries).toEqual([
      first,
      { kind: "settings", workspaceId: "one", section: "model" },
    ]);
    expect(history.forward(valid)).toBeNull();
  });

  it("replays without recording and skips invalid destinations", () => {
    const history = useNavigationHistoryStore.getState();
    const first: NavigationLocation = { kind: "newThread", workspaceId: "one" };
    const deleted: NavigationLocation = {
      kind: "thread",
      workspaceId: "one",
      threadId: "deleted",
    };
    const current: NavigationLocation = {
      kind: "settings",
      workspaceId: "one",
      section: "about",
    };
    history.record(first);
    history.record(deleted);
    history.record(current);

    expect(history.back((location) => location !== deleted)).toEqual(first);
    history.record(first);

    expect(useNavigationHistoryStore.getState()).toMatchObject({
      entries: [first, deleted, current],
      index: 0,
      replayTarget: null,
    });
  });

  it("resumes recording after a failed replay is cleared", () => {
    const history = useNavigationHistoryStore.getState();
    const first: NavigationLocation = { kind: "newThread", workspaceId: "one" };
    const second: NavigationLocation = {
      kind: "settings",
      workspaceId: "one",
      section: "about",
    };
    history.record(first);
    history.record(second);
    expect(history.back(valid)).toEqual(first);

    history.clearReplayTarget();
    history.record(second);

    expect(useNavigationHistoryStore.getState()).toMatchObject({
      entries: [first, second],
      index: 1,
      replayTarget: null,
    });
  });

  it("bounds retained entries to the current window session limit", () => {
    const history = useNavigationHistoryStore.getState();
    for (let index = 0; index < NAVIGATION_HISTORY_LIMIT + 5; index += 1) {
      history.record({
        kind: "thread",
        workspaceId: "one",
        threadId: String(index),
      });
    }

    const state = useNavigationHistoryStore.getState();
    expect(state.entries).toHaveLength(NAVIGATION_HISTORY_LIMIT);
    expect(state.entries[0]).toMatchObject({ threadId: "5" });
    expect(state.index).toBe(NAVIGATION_HISTORY_LIMIT - 1);
  });
});
