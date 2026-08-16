import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@mcode/contracts";
import { Composer } from "../Composer";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  usePreviewAnnotationStore,
  type SavedDiffAnnotation,
  type SavedPreviewAnnotation,
} from "@/features/preview/state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { useQueueStore } from "@/stores/queueStore";
import { resetThreadStoreForTests, seedThreadRecord } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread, createMockWorkspace } from "@/__tests__/mocks/transport";
import type { GitBranch } from "@/transport";

let lastComposerText = "";
const EMPTY_QUEUE: [] = [];

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

vi.mock("@/components/chat/lexical", () => ({
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

vi.mock("@/components/chat/useFileAutocomplete", () => ({
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

vi.mock("@/components/chat/useSlashCommand", () => ({
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

vi.mock("@/components/chat/ModeSelector", () => ({
  ALL_MODE_OPTIONS: [
    { value: "direct", label: "Direct" },
    { value: "worktree", label: "New worktree" },
    { value: "existing-worktree", label: "Existing worktree" },
  ],
  ModeSelector: ({ mode }: { mode: string }) => <div data-testid="mode-selector">{mode}</div>,
}));

vi.mock("@/components/chat/BranchPicker", () => ({
  BranchPicker: ({
    selectedBranch,
    onFetchAndSelect,
  }: {
    selectedBranch: string;
    onFetchAndSelect?: (branch: string, prNumber: number) => void;
  }) => (
    <div data-testid="branch-picker">
      {selectedBranch}
      {onFetchAndSelect ? (
        <button
          type="button"
          onClick={() => onFetchAndSelect("contributor/pr-branch", 42)}
        >
          Select PR branch
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/chat/WorktreePicker", () => ({
  default: () => <div data-testid="worktree-picker" />,
}));

vi.mock("@/components/chat/ModelSelector", () => ({
  ModelSelector: () => <div />,
}));

vi.mock("@/components/chat/CopilotAgentSelector", () => ({
  CopilotAgentSelector: () => <div />,
}));

vi.mock("@/components/chat/AttachmentPreview", () => ({
  AttachmentPreview: ({ attachments }: { attachments: Array<{ name: string }> }) => (
    <div data-testid="attachment-preview">
      {attachments.map((attachment) => attachment.name).join(",")}
    </div>
  ),
}));

vi.mock("@/components/chat/FileTagPopup", () => ({
  FileTagPopup: () => <div />,
  useFileTagPopup: () => ({
    listRef: { current: null },
    selectedIndex: 0,
    onKeyDown: vi.fn(),
  }),
}));

vi.mock("@/components/chat/SpellcheckContextMenu", () => ({
  SpellcheckContextMenu: () => <div />,
}));

vi.mock("@/components/chat/TerminalStatusIndicator", () => ({
  TerminalStatusIndicator: () => <div />,
}));

vi.mock("@/components/chat/PrDetectedCard", () => ({
  PrDetectedCard: () => <div />,
}));

vi.mock("@/components/chat/ComposerQueueList", () => ({
  ComposerQueueList: ({
    threadId,
    onLoadIntoComposer,
  }: {
    threadId: string;
    onLoadIntoComposer: (message: unknown) => void;
  }) => {
    const queue = useQueueStore((s) => s.queues[threadId] ?? EMPTY_QUEUE);
    return React.createElement(
      "div",
      null,
      queue.map((message) =>
        React.createElement(
          "button",
          {
            key: message.id,
            type: "button",
            "aria-label": `Edit ${message.displayContent ?? message.content}`,
            onClick: () => onLoadIntoComposer(message),
          },
          "Edit",
        ),
      ),
    );
  },
}));

vi.mock("@/components/chat/ContextTracker", () => ({
  ContextTracker: () => <div />,
}));

vi.mock("@/components/chat/CompactingBanner", () => ({
  CompactingBanner: () => <div />,
}));

vi.mock("@/components/chat/RetryBanner", () => ({
  RetryBanner: () => <div />,
}));

vi.mock("@/components/chat/SlashCommandPopup", () => ({
  SlashCommandPopup: () => <div />,
}));

vi.mock("@/components/chat/ProviderUnavailableBanner", () => ({
  ProviderUnavailableBanner: () => <div />,
}));

function seedComposerState(
  mode: "direct" | "worktree" | "existing-worktree",
  isGitRepo = true,
) {
  const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: isGitRepo });
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

function makeSavedAnnotation(): SavedPreviewAnnotation {
  return {
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
  };
}

function makePreviewAnnotationBundle() {
  const { createdAt, ...annotation } = makeSavedAnnotation();
  void createdAt;
  return {
    schemaVersion: 1 as const,
    annotations: [annotation],
  };
}

function makeSavedDiffAnnotation(): SavedDiffAnnotation {
  return {
    kind: "diff",
    id: "550e8400-e29b-41d4-a716-446655440002",
    displayNumber: 2,
    filePath: "apps/web/src/features/conversation/composer/Composer.tsx",
    side: "right",
    line: 946,
    lineContent: "const diffAnnotationRows = usePreviewAnnotationStore(...);",
    note: "Keep this review target attached to the next prompt.",
    createdAt: 1_783_036_800_001,
  };
}

describe("Composer checkout confirmation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    lastComposerText = "";
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    useQueueStore.setState({ queues: {}, toast: null, editingThreadId: null });
    usePreviewAnnotationStore.setState({ byThread: {}, diffByThread: {}, drafts: {} });
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
      {
        ...createMockThread({ id: "thread-created", workspace_id: "ws-1", branch: "feature/base" }),
        runtimeSnapshot: {
          threadId: "thread-created",
          turnExecutionId: "exec-test",
          phase: "running",
        },
      },
    );
  });

  it("shows project, checkout mode, and branch in the new-thread context strip", () => {
    const workspace = seedComposerState("direct");
    render(<Composer isNewThread workspaceId="ws-1" />);

    const strip = screen.getByTestId("new-thread-context-strip");
    expect(within(strip).getByText(workspace.name)).toBeInTheDocument();
    expect(within(strip).getByTestId("mode-selector")).toHaveTextContent("direct");
    expect(within(strip).getByTestId("branch-picker")).toHaveTextContent("feature/base");
  });

  it("shows a non-git project as local without checkout controls", () => {
    const workspace = seedComposerState("worktree", false);
    render(<Composer isNewThread workspaceId="ws-1" />);

    const strip = screen.getByTestId("new-thread-context-strip");
    expect(within(strip).getByText(workspace.name)).toBeInTheDocument();
    expect(within(strip).getByText("Local")).toBeInTheDocument();
    expect(within(strip).queryByTestId("mode-selector")).not.toBeInTheDocument();
    expect(within(strip).queryByTestId("branch-picker")).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().newThreadMode).toBe("worktree");
  });

  it("clears the selected project without deleting it", async () => {
    const workspace = seedComposerState("direct");
    render(<Composer isNewThread workspaceId="ws-1" />);

    await userEvent.click(
      screen.getByRole("button", { name: `Clear ${workspace.name} project` }),
    );

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(useWorkspaceStore.getState().workspaces).toContainEqual(workspace);
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
    expect(screen.getByLabelText("Send message")).toHaveClass("size-8");
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

  it("preserves PR branch selection when submitting a new worktree thread", async () => {
    seedComposerState("worktree");
    (mockTransport.fetchBranch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(<Composer isNewThread workspaceId="ws-1" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Select PR branch" }));
    await waitFor(() =>
      expect(mockTransport.fetchBranch).toHaveBeenCalledWith(
        "ws-1",
        "contributor/pr-branch",
        42,
      ),
    );

    await user.type(screen.getByLabelText("Message Mcode"), "Review this PR");
    await user.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalled());
    const createCommand = (
      mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0];
    expect(createCommand).toMatchObject({
      mode: "worktree",
      branch: "contributor/pr-branch",
      worktreeBranchMode: "named",
    });
  });

  it("reports the created thread to an embedding new-thread workflow", async () => {
    seedComposerState("worktree");
    const onThreadCreated = vi.fn();
    render(
      <Composer
        isNewThread
        workspaceId="ws-1"
        onThreadCreated={onThreadCreated}
      />,
    );

    await typeAndSend();

    await waitFor(() =>
      expect(onThreadCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "thread-created" }),
      ),
    );
  });

  it("clears annotations and comments after a successful feedback send", async () => {
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
        [thread.id]: [makeSavedAnnotation()],
      },
      diffByThread: {
        [thread.id]: [makeSavedDiffAnnotation()],
      },
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    expect(screen.getByTestId("composer-annotation-bundle")).toHaveTextContent(
      "1 annotation · 1 comment",
    );
    expect(screen.getByTestId("composer-annotation-bundle")).toHaveClass(
      "bg-accent",
      "text-accent-foreground",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalled());
    const sendCommand = (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(sendCommand?.previewAnnotations).toMatchObject({
      schemaVersion: 1,
      annotations: [
        { id: "550e8400-e29b-41d4-a716-446655440001" },
        {
          kind: "diff",
          id: "550e8400-e29b-41d4-a716-446655440002",
          filePath: "apps/web/src/features/conversation/composer/Composer.tsx",
          line: 946,
          note: "Keep this review target attached to the next prompt.",
        },
      ],
    });
    expect(usePreviewAnnotationStore.getState().byThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewAnnotationStore.getState().diffByThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewDesignModeStore.getState().modes[thread.id]).toBe(false);
  });

  it("clears annotations and comments as soon as feedback dispatch starts", async () => {
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
        [thread.id]: [makeSavedAnnotation()],
      },
      diffByThread: {
        [thread.id]: [makeSavedDiffAnnotation()],
      },
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>(() => {}),
    );

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    await userEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalled());

    expect(screen.queryByTestId("composer-annotation-bundle")).not.toBeInTheDocument();
    expect(usePreviewAnnotationStore.getState().byThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewAnnotationStore.getState().diffByThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewDesignModeStore.getState().modes[thread.id]).toBe(false);
  });

  it("sends workspace-scoped annotations from a new thread composer", async () => {
    seedComposerState("direct");
    useWorkspaceStore.setState({
      newThreadBranch: "main",
      branches: [branch("main", true)],
    });
    usePreviewDesignModeStore.getState().setActive("ws-1", true);
    usePreviewAnnotationStore.setState({
      drafts: {},
      byThread: {
        "ws-1": [makeSavedAnnotation()],
      },
    });

    render(<Composer isNewThread workspaceId="ws-1" />);

    expect(screen.getByTestId("composer-annotation-bundle")).toHaveTextContent(
      "1 annotation",
    );
    await userEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(mockTransport.createAndSendMessage).toHaveBeenCalled());
    const createCommand = (
      mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0];
    expect(createCommand?.previewAnnotations).toMatchObject({
      schemaVersion: 1,
      annotations: [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          note: "Make the content flush with the page edge.",
        },
      ],
    });
    expect(usePreviewAnnotationStore.getState().byThread["ws-1"] ?? []).toEqual([]);
    expect(usePreviewDesignModeStore.getState().modes["ws-1"]).toBe(false);
  });

  it("keeps annotations on a handoff queued send when the handoff becomes ready", async () => {
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
    resetThreadStoreForTests({
      records: seedThreadRecord(thread.id, {
        handoffMeta: { status: "ready" },
      }),
    });
    usePreviewAnnotationStore.setState({
      drafts: {},
      byThread: {
        [thread.id]: [makeSavedAnnotation()],
      },
    });
    usePreviewDesignModeStore.getState().setActive(thread.id, true);
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    await waitFor(() =>
      expect(
        useThreadStore.getState().records.get(thread.id)?.handoffMeta?.status,
      ).toBe("ready"),
    );
    act(() => {
      useThreadStore.setState({
        records: seedThreadRecord(thread.id, {
          handoffMeta: { status: "generating" },
        }),
      });
    });

    const user = userEvent.setup();
    window.desktopBridge = {
      getPathForFile: () => "C:\\tmp\\handoff.txt",
    } as unknown as typeof window.desktopBridge;
    await user.upload(
      screen.getByTestId("composer-attachment-input"),
      new File(["handoff context"], "handoff.txt", { type: "text/plain" }),
    );
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    expect(screen.getByTestId("attachment-preview")).toHaveTextContent("handoff.txt");
    await user.type(screen.getByLabelText("Message Mcode"), "Queued follow-up");
    await user.click(screen.getByLabelText("Send message"));
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();

    act(() => {
      useThreadStore.setState({
        records: seedThreadRecord(thread.id, {
          handoffMeta: { status: "ready" },
        }),
      });
    });

    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalled());
    expect(screen.queryByTestId("composer-annotation-bundle")).not.toBeInTheDocument();
    expect(screen.getByTestId("attachment-preview")).toBeEmptyDOMElement();
    expect(usePreviewAnnotationStore.getState().byThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewDesignModeStore.getState().modes[thread.id]).toBe(false);
    const sendCommand = (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(sendCommand?.attachments).toEqual([
      expect.objectContaining({
        name: "handoff.txt",
        mimeType: "text/plain",
        sourcePath: "C:\\tmp\\handoff.txt",
      }),
    ]);
    expect(sendCommand?.previewAnnotations).toMatchObject({
      schemaVersion: 1,
      annotations: [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          note: "Make the content flush with the page edge.",
        },
      ],
    });
  });

  it("preserves annotations when swapping away from an edited queued message", async () => {
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
    const previewAnnotations = makePreviewAnnotationBundle();
    useQueueStore.getState().enqueue(thread.id, {
      content: "Message A",
      displayContent: "Message A",
      mentions: undefined,
      previewAnnotations,
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });
    useQueueStore.getState().enqueue(thread.id, {
      content: "Message B",
      displayContent: "Message B",
      mentions: undefined,
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    await userEvent.click(screen.getByLabelText("Edit Message A"));
    await userEvent.type(screen.getByLabelText("Message Mcode"), "Message A edited");
    await userEvent.click(screen.getByLabelText("Edit Message B"));

    await waitFor(() => {
      const queue = useQueueStore.getState().queues[thread.id] ?? [];
      expect(queue[0]).toMatchObject({
        content: "Message A edited",
        previewAnnotations,
      });
    });
  });

  it("drops restored annotations when the chip is removed before saving a queued edit", async () => {
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
    resetThreadStoreForTests({
      runningThreadIds: new Set([thread.id]),
      records: seedThreadRecord(thread.id),
    });
    useQueueStore.getState().enqueue(thread.id, {
      content: "Fix the preview",
      displayContent: "Fix the preview",
      mentions: undefined,
      previewAnnotations: makePreviewAnnotationBundle(),
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Edit Fix the preview"));
    await user.click(screen.getByLabelText("Remove 1 annotation"));
    await user.type(screen.getByLabelText("Message Mcode"), "Fix the preview without annotations");
    await user.click(screen.getByLabelText("Queue message"));

    await waitFor(() => {
      const queue = useQueueStore.getState().queues[thread.id] ?? [];
      expect(queue[0]).toMatchObject({
        content: "Fix the preview without annotations",
      });
      expect(queue[0]?.previewAnnotations).toBeUndefined();
    });
  });

  it("sends undefined annotations after a restored queued annotation chip is removed", async () => {
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
    useQueueStore.getState().enqueue(thread.id, {
      content: "Fix the preview",
      displayContent: "Fix the preview",
      mentions: undefined,
      previewAnnotations: makePreviewAnnotationBundle(),
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Edit Fix the preview"));
    await user.click(screen.getByLabelText("Remove 1 annotation"));
    await user.type(screen.getByLabelText("Message Mcode"), "Fix the preview without annotations");
    await user.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalled());
    const sendCommand = (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(sendCommand?.previewAnnotations).toBeUndefined();
  });

  it("does not resurrect restored annotations when swapping after chip removal", async () => {
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
    useQueueStore.getState().enqueue(thread.id, {
      content: "Message A",
      displayContent: "Message A",
      mentions: undefined,
      previewAnnotations: makePreviewAnnotationBundle(),
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });
    useQueueStore.getState().enqueue(thread.id, {
      content: "Message B",
      displayContent: "Message B",
      mentions: undefined,
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Edit Message A"));
    await user.click(screen.getByLabelText("Remove 1 annotation"));
    await user.type(screen.getByLabelText("Message Mcode"), "Message A edited");
    await user.click(screen.getByLabelText("Edit Message B"));

    await waitFor(() => {
      const queue = useQueueStore.getState().queues[thread.id] ?? [];
      expect(queue[0]).toMatchObject({
        content: "Message A edited",
      });
      expect(queue[0]?.previewAnnotations).toBeUndefined();
    });
  });

  it("removes an annotation-only queued edit after clearing the restored chip", async () => {
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
    useQueueStore.getState().enqueue(thread.id, {
      content: "",
      displayContent: "",
      mentions: undefined,
      previewAnnotations: makePreviewAnnotationBundle(),
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Edit\s*$/ }));
    await user.click(screen.getByLabelText("Remove 1 annotation"));
    await user.click(screen.getByLabelText("Send message"));

    await waitFor(() => {
      expect(useQueueStore.getState().queues[thread.id] ?? []).toEqual([]);
    });
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
  });

  it("restores queued annotations into composer edit state", async () => {
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
    const previewAnnotations = makePreviewAnnotationBundle();
    useQueueStore.getState().enqueue(thread.id, {
      content: "Fix the preview",
      displayContent: "Fix the preview",
      mentions: undefined,
      previewAnnotations,
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    await userEvent.click(screen.getByLabelText("Edit Fix the preview"));

    expect(screen.getByTestId("composer-annotation-bundle")).toHaveTextContent(
      "1 annotation",
    );
    expect(usePreviewAnnotationStore.getState().byThread[thread.id]).toMatchObject([
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        note: "Make the content flush with the page edge.",
      },
    ]);
    expect(usePreviewDesignModeStore.getState().modes[thread.id]).toBe(true);
  });

  it("keeps rendered stop control through stale A terminal and B text", async () => {
    const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
    const thread = createMockThread({ id: "thread-1", workspace_id: workspace.id });
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
    resetThreadStoreForTests({ currentThreadId: thread.id, runningThreadIds: new Set([thread.id]) });
    useThreadStore.setState({
      records: seedThreadRecord(thread.id, { runtimePhase: "running", turnExecutionId: "exec-b" }),
    });

    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);
    expect(screen.getByLabelText("Stop agent")).toBeInTheDocument();

    const handleAgentEvent = useThreadStore.getState().handleAgentEvent;
    act(() => {
      handleAgentEvent({ type: "ended", threadId: thread.id, turnExecutionId: "exec-a" } as AgentEvent);
      handleAgentEvent({ type: "textDelta", threadId: thread.id, delta: "B text", turnExecutionId: "exec-b" } as AgentEvent);
    });
    expect(screen.getByLabelText("Stop agent")).toBeInTheDocument();

    act(() => {
      handleAgentEvent({ type: "ended", threadId: thread.id, turnExecutionId: "exec-b" } as AgentEvent);
    });
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
  });
});
