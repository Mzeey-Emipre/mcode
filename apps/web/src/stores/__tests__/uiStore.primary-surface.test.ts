import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore";

describe("uiStore primary surface", () => {
  beforeEach(() => {
    useUiStore.setState({
      primarySurface: "chat",
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
      projectThreadViews: {},
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

  it("keeps independent Project thread views for the app session", () => {
    useUiStore.getState().setProjectThreadView("project-a", "completed");
    useUiStore.getState().toggleProjectThreadView("project-b");

    expect(useUiStore.getState().projectThreadViews).toEqual({
      "project-a": "completed",
      "project-b": "completed",
    });

    useUiStore.getState().toggleProjectThreadView("project-a");

    expect(useUiStore.getState().projectThreadViews).toEqual({
      "project-a": "active",
      "project-b": "completed",
    });
  });
});
