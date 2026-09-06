import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";

const watchWorkspaceFiles = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/transport", () => ({
  getTransport: () => ({ watchWorkspaceFiles }),
}));

import { useWorkspaceFileInvalidation } from "./useWorkspaceFileInvalidation";

function InvalidationSubscriber() {
  useWorkspaceFileInvalidation("workspace-1", "thread-1");
  return null;
}

describe("useWorkspaceFileInvalidation", () => {
  beforeEach(() => {
    watchWorkspaceFiles.mockClear();
    watchWorkspaceFiles.mockResolvedValue(undefined);
    act(() => useConnectionStore.getState().setStatus("connecting"));
  });

  it("subscribes when the connection opens and again after reconnect", async () => {
    render(<InvalidationSubscriber />);
    expect(watchWorkspaceFiles).not.toHaveBeenCalled();

    act(() => useConnectionStore.getState().setStatus("connected"));
    await waitFor(() => expect(watchWorkspaceFiles).toHaveBeenCalledTimes(1));
    expect(watchWorkspaceFiles).toHaveBeenLastCalledWith("workspace-1", "thread-1");

    act(() => useConnectionStore.getState().setStatus("reconnecting"));
    act(() => useConnectionStore.getState().setStatus("connected"));
    await waitFor(() => expect(watchWorkspaceFiles).toHaveBeenCalledTimes(2));
  });

  it("reports a subscription failure that is not caused by a disconnected transport", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    watchWorkspaceFiles.mockRejectedValueOnce(new Error("Workspace is unavailable"));

    render(<InvalidationSubscriber />);
    act(() => useConnectionStore.getState().setStatus("connected"));

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      "[files] Failed to subscribe to workspace invalidation",
      expect.objectContaining({ message: "Workspace is unavailable" }),
    ));
    consoleError.mockRestore();
  });
});
