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
      setWorkspaceEnvironmentStorageMode: vi.fn(),
      clearWorkspaceEnvironmentApprovals: vi.fn(),
      listWorkspaceActionRuns: vi.fn(),
    },
  };
});

vi.mock("@/transport", () => ({ getTransport: () => transport, RpcError: MockRpcError }));
vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { workspaces: readonly { id: string; name: string }[] }) => unknown) =>
    selector({ workspaces: [{ id: "workspace-1", name: "Caravan" }] }),
}));

import { ProjectActionMenu, useProjectActions } from "../ProjectActionControl";
import { ProjectEnvironmentPanel } from "../ProjectEnvironmentPanel";
import { useProjectActionStore } from "../state/project-action-store";

const initialResult: WorkspaceEnvironmentReadResult = {
  document: { version: "0.0.1", actions: [] },
  revision: null,
  status: "absent",
};

function MountedProjectActionMenu() {
  const projectActions = useProjectActions("workspace-1", "thread-1");
  return (
    <ProjectActionMenu
      actions={projectActions.actions}
      runsByActionId={projectActions.runsByActionId}
      loadError={projectActions.loadError}
      onStart={async () => undefined}
      onFocus={() => undefined}
      onEdit={() => undefined}
    />
  );
}

describe("ProjectEnvironmentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectActionStore.setState({ runsByThread: {}, configurationEpochByWorkspace: {} });
    transport.readWorkspaceEnvironment.mockResolvedValue(initialResult);
    transport.listWorkspaceActionRuns.mockResolvedValue([]);
    transport.saveWorkspaceEnvironment.mockImplementation(async (
      _workspaceId: string,
      document: WorkspaceEnvironmentDocument,
      _sourceRevision: string | null,
    ) => ({
      document,
      revision: "revision-1",
      status: "present",
    }));
    transport.setWorkspaceEnvironmentStorageMode.mockResolvedValue({
      ...initialResult,
      storageMode: "shared",
    });
    transport.clearWorkspaceEnvironmentApprovals.mockResolvedValue(undefined);
  });

  it("shows the active project and system environment storage before setup is added", async () => {
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await screen.findByRole("button", { name: "Add Setup" });
    expect(screen.getByRole("heading", { name: "Project settings" })).toBeInTheDocument();
    expect(screen.getByText("Caravan")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Environment storage" })).toBeInTheDocument();
    expect(screen.getByText("Only available on this computer.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Optional setup command configuration for this Project.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Default command script")).not.toBeInTheDocument();
  });

  it("moves focus into the setup script when setup is added", async () => {
    const user = userEvent.setup();
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await user.click(await screen.findByRole("button", { name: "Add Setup" }));

    const setupScript = screen.getByLabelText("Default command script");
    await waitFor(() => expect(setupScript).toHaveFocus());
  });

  it("requires confirmation before selecting shared storage and then exposes approval clearing", async () => {
    const user = userEvent.setup();
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" />);

    await screen.findByRole("radio", { name: "Shared storage" });
    await user.click(screen.getByRole("radio", { name: "Shared storage" }));
    expect(transport.setWorkspaceEnvironmentStorageMode).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Share this Project environment?" })).toBeInTheDocument();
    expect(screen.getByText("Before a Setup command or Project action runs from this file, Mcode asks for your approval.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("radio", { name: "System storage" })).toHaveAttribute("aria-checked", "true");
    expect(transport.setWorkspaceEnvironmentStorageMode).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "Shared storage" }));
    await user.click(screen.getByRole("button", { name: "Share environment" }));

    await waitFor(() => expect(transport.setWorkspaceEnvironmentStorageMode).toHaveBeenCalledWith("workspace-1", "shared"));
    expect(screen.getByRole("radio", { name: "Shared storage" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Clear shared command approvals" }));
    await waitFor(() => expect(transport.clearWorkspaceEnvironmentApprovals).toHaveBeenCalledWith("workspace-1"));
  });

  it("reads and saves the selected worktree environment scope", async () => {
    const user = userEvent.setup();
    render(<ProjectEnvironmentPanel workspaceId="workspace-1" threadId="thread-1" />);

    await screen.findByRole("button", { name: "Add Setup" });
    expect(transport.readWorkspaceEnvironment).toHaveBeenCalledWith("workspace-1", "thread-1");
    await user.click(screen.getByRole("button", { name: "Add Setup" }));
    await user.type(screen.getByLabelText("Default command script"), "bun run setup");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledWith(
      "workspace-1",
      { version: "0.0.1", setup: { default: "bun run setup" }, actions: [] },
      null,
      "thread-1",
    ));
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

  it("refreshes a mounted Action menu after saving renamed Project configuration", async () => {
    const user = userEvent.setup();
    let persisted: WorkspaceEnvironmentReadResult = {
      document: {
        version: "0.0.1",
        actions: [{ id: "build", name: "Build", command: { default: "bun run build" } }],
      },
      revision: "revision-1",
      status: "present",
    };
    transport.readWorkspaceEnvironment.mockImplementation(async () => persisted);
    transport.saveWorkspaceEnvironment.mockImplementation(async (
      _workspaceId: string,
      document: WorkspaceEnvironmentDocument,
    ) => {
      persisted = { document, revision: "revision-2", status: "present" };
      return persisted;
    });

    render(<><ProjectEnvironmentPanel workspaceId="workspace-1" /><MountedProjectActionMenu /></>);

    await screen.findByLabelText("Action name for Build");
    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    expect(await screen.findByRole("menuitem", { name: /Build/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const actionName = screen.getByLabelText("Action name for Build");
    await user.clear(actionName);
    await user.type(actionName, "Test");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledOnce());
    await waitFor(() => expect(transport.readWorkspaceEnvironment).toHaveBeenCalledTimes(3));

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    expect(await screen.findByRole("menuitem", { name: /Test/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Build/ })).not.toBeInTheDocument();
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
