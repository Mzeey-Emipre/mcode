import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { usePreviewAnnotationStore } from "@/stores/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { mockTransport, createMockThread, createMockWorkspace } from "@/__tests__/mocks/transport";
import type { GitBranch } from "@/transport";

let lastComposerText = "";

const branch = (name: string, isCurrent = false): GitBranch => ({
  name,
  shortSha: "abc1234",
  type: "local",
  isCurrent,
});

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

vi.mock("../lexical", () => ({
  ComposerEditor: ({
    onChange,
    editorRef,
  }: {
    onChange: (text: string, mentions: []) => void;
    editorRef: React.MutableRefObject<{ update: (fn: () => void) => void; focus: () => void } | null>;
  }) => {
    React.useEffect(() => {
      editorRef.current = {
        update: vi.fn(),
        focus: vi.fn(),
      };
    }, [editorRef]);

    return (
      <textarea
        aria-label="Message Mcode"
        onChange={(event) => {
          lastComposerText = event.target.value;
          onChange(event.target.value, []);
        }}
      />
    );
  },
  $createTypedMentionNode: vi.fn(),
  extractComposerMessage: vi.fn(() => ({ text: lastComposerText, mentions: [] })),
  insertMentionNode: vi.fn(),
  insertSlashCommandNode: vi.fn(),
}));

vi.mock("../useFileAutocomplete", () => ({
  clearFileListCache: vi.fn(),
  useFileAutocomplete: () => ({
    suggestions: [],
    query: "",
    isOpen: false,
    triggerStart: 0,
    selectSuggestion: vi.fn(),
    handleInputChange: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("../useSlashCommand", () => ({
  useSlashCommand: () => ({
    state: null,
    selectedIndex: 0,
    anchorRect: null,
    isOpen: false,
    onInputChange: vi.fn(),
    onDismiss: vi.fn(),
    onSelect: vi.fn(),
    onKeyDown: vi.fn(),
    onRetry: vi.fn(),
  }),
}));

vi.mock("../ModeSelector", () => ({
  ALL_MODE_OPTIONS: [
    { value: "direct", label: "Direct" },
    { value: "worktree", label: "New worktree" },
    { value: "existing-worktree", label: "Existing worktree" },
  ],
  ModeSelector: ({ mode }: { mode: string }) => <div data-testid="mode-selector">{mode}</div>,
}));

vi.mock("../BranchPicker", () => ({
  BranchPicker: ({ selectedBranch }: { selectedBranch: string }) => (
    <div data-testid="branch-picker">{selectedBranch}</div>
  ),
}));

vi.mock("../WorktreePicker", () => ({
  default: () => <div data-testid="worktree-picker" />,
}));

vi.mock("../ModelSelector", () => ({
  ModelSelector: () => <div />,
}));

vi.mock("../CopilotAgentSelector", () => ({
  CopilotAgentSelector: () => <div />,
}));

vi.mock("../AttachmentPreview", () => ({
  AttachmentPreview: () => <div />,
}));

vi.mock("../FileTagPopup", () => ({
  FileTagPopup: () => <div />,
  useFileTagPopup: () => ({
    listRef: { current: null },
    selectedIndex: 0,
    onKeyDown: vi.fn(),
  }),
}));

vi.mock("../SpellcheckContextMenu", () => ({
  SpellcheckContextMenu: () => <div />,
}));

vi.mock("../TerminalStatusIndicator", () => ({
  TerminalStatusIndicator: () => <div />,
}));

vi.mock("../PrDetectedCard", () => ({
  PrDetectedCard: () => <div />,
}));

vi.mock("../ComposerQueueList", () => ({
  ComposerQueueList: () => <div />,
}));

vi.mock("../ContextTracker", () => ({
  ContextTracker: () => <div />,
}));

vi.mock("../CompactingBanner", () => ({
  CompactingBanner: () => <div />,
}));

vi.mock("../RetryBanner", () => ({
  RetryBanner: () => <div />,
}));

vi.mock("../InterruptStopBanner", () => ({
  InterruptStopBanner: () => <div />,
}));

vi.mock("../SlashCommandPopup", () => ({
  SlashCommandPopup: () => <div />,
}));

vi.mock("../ProviderUnavailableBanner", () => ({
  ProviderUnavailableBanner: () => <div />,
}));

function seedComposerState(mode: "direct" | "worktree" | "existing-worktree") {
  const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    threads: [],
    activeThreadId: null,
    branches: [branch("main", true), branch("feature/base")],
    newThreadMode: mode,
    newThreadBranch: "feature/base",
    selectedWorktree: mode === "existing-worktree"
      ? { name: "existing", path: "/repo/.worktrees/existing", branch: "feature/base", managed: true }
      : null,
    worktrees: [],
  });
  return workspace;
}

async function typeAndSend() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message Mcode"), "Build this");
  await user.click(screen.getByLabelText("Send message"));
  return user;
}

describe("Composer checkout confirmation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    lastComposerText = "";
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
    usePreviewDesignModeStore.setState({ modes: {} });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      threads: [],
      activeThreadId: null,
      branches: [],
      newThreadMode: "direct",
      newThreadBranch: "main",
      selectedWorktree: null,
    });
    vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("native confirm should not be used");
    });
    vi.spyOn(window, "alert").mockImplementation(() => {
      throw new Error("native alert should not be used");
    });
    (mockTransport.getCurrentBranch as ReturnType<typeof vi.fn>).mockResolvedValue("main");
    (mockTransport.checkoutBranch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockThread({ id: "thread-created", workspace_id: "ws-1", branch: "feature/base" }),
    );
  });

  it("confirms Direct branch checkout in an app dialog before sending", async () => {
    seedComposerState("direct");
    render(<Composer isNewThread workspaceId="ws-1" />);

    const user = await typeAndSend();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "Switch branch?" })).toBeInTheDocument();
    expect(mockTransport.createAndSendMessage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Switch and send" }));

    await waitFor(() => expect(mockTransport.checkoutBranch).toHaveBeenCalledWith("ws-1", "feature/base"));
    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch branch?" })).not.toBeInTheDocument());
  }, 15_000);

  it("canceling the Direct dialog keeps the draft and skips checkout and send", async () => {
    seedComposerState("direct");
    render(<Composer isNewThread workspaceId="ws-1" />);

    const user = await typeAndSend();
    await screen.findByRole("dialog", { name: "Switch branch?" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch branch?" })).not.toBeInTheDocument());
    expect(mockTransport.checkoutBranch).not.toHaveBeenCalled();
    expect(mockTransport.createAndSendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message Mcode")).toHaveValue("Build this");
    expect(screen.getByLabelText("Send message")).toBeEnabled();
  });

  it("does not inspect or checkout the workspace branch for worktree modes", async () => {
    for (const mode of ["worktree", "existing-worktree"] as const) {
      vi.clearAllMocks();
      seedComposerState(mode);
      const { unmount } = render(<Composer isNewThread workspaceId="ws-1" />);
      await waitFor(() => expect(screen.getByTestId("mode-selector")).toHaveTextContent(mode));

      await typeAndSend();

      await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalled());
      expect(mockTransport.getCurrentBranch).not.toHaveBeenCalled();
      expect(mockTransport.checkoutBranch).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Switch branch?" })).not.toBeInTheDocument();

      unmount();
    }
  });

  it("clears annotations and exits design mode after a successful annotation send", async () => {
    const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
    const thread = createMockThread({ id: "thread-1", workspace_id: "ws-1" });
    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      threads: [thread],
      activeThreadId: thread.id,
      branches: [branch("main", true)],
      newThreadMode: "direct",
      newThreadBranch: "main",
      selectedWorktree: null,
    });
    usePreviewDesignModeStore.getState().setActive(thread.id, true);
    usePreviewAnnotationStore.setState({
      drafts: {},
      byThread: {
        [thread.id]: [
          {
            id: "550e8400-e29b-41d4-a716-446655440001",
            displayNumber: 1,
            pageIdentity: "http://localhost:44354/product-preview",
            pageContext: {
              schemaVersion: 2,
              pageUrl: "http://localhost:44354/product-preview",
              pageTitle: "Product preview",
              capturedAt: "2026-07-01T00:00:00.000Z",
              bounds: { x: 0, y: 0, width: 1280, height: 720 },
            },
            targetContext: {
              label: "html",
              selectorHint: "html",
              bounds: { x: 12, y: 16, width: 240, height: 80 },
            },
            note: "Make the content flush with the page edge.",
            snapshot: {
              id: "shot-1",
              name: "annotation.png",
              mimeType: "image/png",
              sizeBytes: 128,
              sourcePath: "preview/annotation.png",
              capture: {
                schemaVersion: 2,
                pageUrl: "http://localhost:44354/product-preview",
                pageTitle: "Product preview",
                capturedAt: "2026-07-01T00:00:00.000Z",
                bounds: { x: 12, y: 16, width: 240, height: 80 },
              },
            },
            createdAt: 1_783_036_800_000,
          },
        ],
      },
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    expect(screen.getByTestId("composer-annotation-bundle")).toHaveTextContent(
      "1 annotation",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalled());
    expect(usePreviewAnnotationStore.getState().byThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewDesignModeStore.getState().modes[thread.id]).toBe(false);
  });
});
