import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore";

describe("uiStore primary surface", () => {
  beforeEach(() => {
    useUiStore.setState({
      primarySurface: "chat",
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
  });

  it("opens Pull requests without leaving a maximized chat panel behind", () => {
    useUiStore.setState({
      rightPanelMaximized: true,
      rightPanelMaximizedByLayout: true,
    });

    useUiStore.getState().setPrimarySurface("pullRequests");

    expect(useUiStore.getState()).toMatchObject({
      primarySurface: "pullRequests",
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
  });

  it("returns to the chat surface", () => {
    useUiStore.getState().setPrimarySurface("pullRequests");
    useUiStore.getState().setPrimarySurface("chat");

    expect(useUiStore.getState().primarySurface).toBe("chat");
  });
});
