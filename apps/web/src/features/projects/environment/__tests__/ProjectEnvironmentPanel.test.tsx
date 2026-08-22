import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentDocument, WorkspaceEnvironmentReadResult } from "@mcode/contracts";

const { transport, MockRpcError } = vi.hoisted(() => {
  class MockRpcError extends Error {
    readonly data?: Record<string, unknown>;

    constructor(message: string, readonly code: string, data?: Record<string, unknown>) {
      super(message);
      this.name = "RpcError";
      this.data = data;
    }
  }
  return {
    MockRpcError,
    transport: {
      readWorkspaceEnvironment: vi.fn(),
      saveWorkspaceEnvironment: vi.fn(),
    },
  };
});

vi.mock("@/transport", () => ({ getTransport: () => transport, RpcError: MockRpcError }));
vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { workspaces: readonly { id: string; name: string }[] }) => unknown) =>
    selector({ workspaces: [{ id: "workspace-1", name: "Caravan" }] }),
}));

import { ProjectEnvironmentPanel } from "../ProjectEnvironmentPanel";

const initialResult: WorkspaceEnvironmentReadResult = {
  document: { version: "0.0.1", actions: [] },
  revision: null,
  status: "absent",
};

describe("ProjectEnvironmentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.readWorkspaceEnvironment.mockResolvedValue(initialResult);
    transport.saveWorkspaceEnvironment.mockImplementation(async (
      _workspaceId: string,
      document: WorkspaceEnvironmentDocument,
      _sourceRevision: string | null,
    ) => ({
      document,
      revision: "revision-1",
      status: "present",
    }));
  });

  it("shows the active project and private environment storage before setup is added", async () => {
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await screen.findByRole("button", { name: "Add Setup" });
    expect(screen.getByRole("heading", { name: "Project settings" })).toBeInTheDocument();
    expect(screen.getByText("Caravan")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Environment" })).toBeInTheDocument();
    expect(screen.getByText("This document is saved in Mcode’s user data on this computer.")).toBeInTheDocument();
    expect(screen.getByText("Optional setup command configuration for this Project.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Default command script")).not.toBeInTheDocument();
  });

  it("edits setup and named actions, preserves action identity, and saves", async () => {
    const user = userEvent.setup();
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await screen.findByRole("button", { name: "Add Setup" });
    await user.click(screen.getByRole("button", { name: "Add Setup" }));
    const setupScript = screen.getByLabelText("Default command script");
    await user.type(setupScript, "npm run setup");

    await user.click(screen.getByRole("button", { name: "Add action" }));
    const actionName = screen.getByLabelText("Action name for New action");
    await user.clear(actionName);
    await user.type(actionName, "Build");
    const scripts = screen.getAllByLabelText("Default command script");
    await user.type(scripts[1], "npm run build");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledTimes(1));
    const savedDocument = transport.saveWorkspaceEnvironment.mock.calls[0][1] as WorkspaceEnvironmentDocument;
    expect(savedDocument.setup?.default).toBe("npm run setup");
    expect(savedDocument.actions).toHaveLength(1);
    expect(savedDocument.actions[0].name).toBe("Build");
    expect(savedDocument.actions[0].id).toEqual(expect.any(String));
    expect(screen.getByRole("status")).toHaveTextContent("Environment saved");
  });

  it("uses the prototype platform order and moves between editors with keyboard tabs", async () => {
    const user = userEvent.setup();
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);
    await screen.findByRole("button", { name: "Add Setup" });
    await user.click(screen.getByRole("button", { name: "Add Setup" }));

    const defaultTab = screen.getByRole("tab", { name: "Default" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Default",
      "macOS",
      "Linux",
      "Windows",
    ]);
    defaultTab.focus();
    fireEvent.keyDown(defaultTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "macOS" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("macOS command script")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "macOS" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Windows" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Windows command script")).toBeInTheDocument();
  });

  it("focuses the first task control after the initial read succeeds", async () => {
    let resolveRead!: (result: WorkspaceEnvironmentReadResult) => void;
    transport.readWorkspaceEnvironment.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" active />);
    expect(screen.queryByRole("button", { name: "Add Setup" })).not.toBeInTheDocument();

    resolveRead(initialResult);
    const addSetup = await screen.findByRole("button", { name: "Add Setup" });
    await waitFor(() => expect(addSetup).toHaveFocus());
  });

  it("keeps edits made while a save is in flight", async () => {
    const user = userEvent.setup();
    let resolveSave!: (result: WorkspaceEnvironmentReadResult) => void;
    transport.saveWorkspaceEnvironment.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await screen.findByRole("button", { name: "Add Setup" });
    await user.click(screen.getByRole("button", { name: "Add Setup" }));
    const setupScript = screen.getByLabelText("Default command script");
    await user.type(setupScript, "submitted");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledTimes(1));

    await user.clear(setupScript);
    await user.type(setupScript, "local edit");
    resolveSave({
      document: { version: "0.0.1", setup: { default: "server snapshot" }, actions: [] },
      revision: "revision-2",
      status: "present",
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Environment saved"));
    expect(setupScript).toHaveValue("local edit");
  });

  it("replaces a draft on Reload and sends the new revision on Save", async () => {
    const user = userEvent.setup();
    let readCount = 0;
    transport.readWorkspaceEnvironment.mockImplementation(async () => {
      readCount += 1;
      return readCount === 1
        ? initialResult
        : {
            document: { version: "0.0.1", setup: { default: "server setup" }, actions: [] },
            revision: "revision-2",
            status: "present",
          } satisfies WorkspaceEnvironmentReadResult;
    });
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await screen.findByRole("button", { name: "Add Setup" });
    await user.click(screen.getByRole("button", { name: "Add Setup" }));
    const setupScript = screen.getByLabelText("Default command script");
    await user.type(setupScript, "local draft");
    await user.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByLabelText("Default command script")).toHaveValue("server setup"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledTimes(1));
    expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledWith(
      "workspace-1",
      { version: "0.0.1", setup: { default: "server setup" }, actions: [] },
      "revision-2",
    );
  });

  it("shows structured save errors and preserves the user draft", async () => {
    const user = userEvent.setup();
    transport.saveWorkspaceEnvironment.mockRejectedValueOnce(new MockRpcError(
      "Workspace environment failed validation",
      "WORKSPACE_ENVIRONMENT_VALIDATION",
      {
        issues: [{
          path: ["setup", "default"],
          code: "EMPTY_SCRIPT",
          reason: "empty_script",
          message: "A command must contain at least one non-empty script",
        }],
      },
    ));
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await screen.findByRole("button", { name: "Add Setup" });
    await user.click(screen.getByRole("button", { name: "Add Setup" }));
    const setupScript = screen.getByLabelText("Default command script");
    await user.type(setupScript, "preserve this draft");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert", { name: "Project environment errors" });
    expect(alert).toHaveTextContent("setup.default");
    expect(alert).toHaveTextContent("empty_script");
    expect(setupScript).toHaveValue("preserve this draft");
  });
});
