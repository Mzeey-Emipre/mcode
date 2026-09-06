import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, SelectedTextComment } from "@mcode/contracts";
import { Composer } from "../../Composer";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  usePreviewAnnotationStore,
  type SavedDiffAnnotation,
  type SavedPreviewAnnotation,
} from "@/features/preview/state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { useQueueStore } from "@/stores/queueStore";
import {
  getTestThreadMessages,
  resetThreadStoreForTests,
  seedThreadRecord,
} from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { mockTransport, createMockThread, createMockWorkspace } from "@/__tests__/mocks/transport";
import type { GitBranch } from "@/transport";

let lastComposerText = "";
let lastFileAutocompleteOptions: Record<string, unknown> | undefined;
let lastSlashCommandOptions: Record<string, unknown> | undefined;
const EMPTY_QUEUE: [] = [];

const transcriptComments: readonly SelectedTextComment[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    displayNumber: 1,
    source: {
      threadId: "thread-comment",
      messageId: "message-1",
      sourceRole: "assistant",
      start: 0,
      end: 5,
      quote: "First",
    },
    note: "First note",
    mentions: [],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    displayNumber: 2,
    source: {
      threadId: "thread-comment",
      messageId: "message-1",
      sourceRole: "assistant",
      start: 6,
      end: 12,
      quote: "Second",
    },
    note: "Second note",
    mentions: [],
  },
];

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
    ariaLabel,
  }: {
    onChange: (text: string, mentions: []) => void;
    editorRef: React.MutableRefObject<{ update: (fn: () => void) => void; focus: () => void } | null>;
    ariaLabel?: string;
  }) => {
    React.useEffect(() => {
      editorRef.current = {
        update: vi.fn(),
        focus: vi.fn(),
      };
    }, [editorRef]);

    return (
      <textarea
        aria-label={ariaLabel}
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

vi.mock("@/features/conversation/composer/draft/composer-editor-content", () => ({
  writeComposerContent: vi.fn((_editor: unknown, text: string) => {
    lastComposerText = text;
  }),
}));

vi.mock("@/components/chat/useFileAutocomplete", () => ({
  clearFileListCache: vi.fn(),
  useFileAutocomplete: (options: Record<string, unknown>) => {
    lastFileAutocompleteOptions = options;
    return {
      suggestions: [],
      query: "",
      isOpen: false,
      triggerStart: 0,
      selectSuggestion: vi.fn(),
      handleInputChange: vi.fn(),
      dismiss: vi.fn(),
    };
  },
}));

vi.mock("@/components/chat/useSlashCommand", () => ({
  useSlashCommand: (options: Record<string, unknown>) => {
    lastSlashCommandOptions = options;
    return {
      state: null,
      selectedIndex: 0,
      anchorRect: null,
      isOpen: false,
      onInputChange: vi.fn(),
      onDismiss: vi.fn(),
      onSelect: vi.fn(),
      onKeyDown: vi.fn(),
      onRetry: vi.fn(),
    };
  },
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
  AttachmentPreview: ({ attachments }: { attachments: Array<{ name: string; previewUrl: string }> }) => (
    <div data-testid="attachment-preview">
      {attachments.map((attachment) => (
        <div key={attachment.name}>
          {attachment.name}
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt={`Preview image ${attachment.name}`} />
          ) : null}
        </div>
      ))}
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
    isAgentRunning,
    onLoadIntoComposer,
  }: {
    threadId: string;
    isAgentRunning: boolean;
    onLoadIntoComposer: (message: unknown) => void;
  }) => {
    const queue = useQueueStore((s) => s.queues[threadId] ?? EMPTY_QUEUE);
    return React.createElement(
      "div",
      null,
      !isAgentRunning
        ? React.createElement(
          "button",
          { type: "button", "aria-label": "Send next queued message" },
          "Continue",
        )
        : null,
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

function seedPreparingComposerState() {
  const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
  const placeholder = createMockThread({
    id: "thread-placeholder",
    workspace_id: workspace.id,
    mode: "worktree",
    provider: "codex",
    worktree_path: "/repo/.worktrees/placeholder",
  });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    threads: [{ ...placeholder, clientPreparing: true, clientPreparingContext: "new-existing-worktree" }],
    activeThreadId: placeholder.id,
    branches: [branch("main", true)],
    newThreadMode: "existing-worktree",
    newThreadBranch: "main",
    selectedWorktree: { name: "selected", path: "/repo/.worktrees/selected", branch: "main", managed: true },
  });
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
  beforeAll(() => {
    if (typeof window.ResizeObserver === "undefined") {
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    lastComposerText = "";
    lastFileAutocompleteOptions = undefined;
    lastSlashCommandOptions = undefined;
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    useComposerDraftStore.setState({ drafts: {}, pendingPrefill: null });
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      disposedQueuedMessages: {},
      queueGenerations: {},
      toast: null,
      editingThreadId: null,
    });
    usePreviewAnnotationStore.setState({ byThread: {}, diffByThread: {}, drafts: {} });
    usePreviewDesignModeStore.setState({ modes: {} });
    useToastStore.setState({ toasts: [] });
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
    delete (window as unknown as Record<string, unknown>).desktopBridge;
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

  it("applies a transcript deletion to the matching ComposerDraft and consumes the handoff", async () => {
    const workspace = seedComposerState("direct");
    const thread = createMockThread({
      id: "thread-comment",
      workspace_id: workspace.id,
      mode: "direct",
      provider: "claude",
    });
    useWorkspaceStore.setState({ threads: [thread], activeThreadId: thread.id });
    useComposerDraftStore.setState({
      drafts: {
        [thread.id]: {
          input: "",
          attachments: [],
          modelId: "model",
          reasoning: "low",
          selectedTextComments: [...transcriptComments],
        },
      },
    });
    const onSelectedTextCommentDeletionConsumed = vi.fn();

    const { rerender } = render(
      <Composer
        threadId={thread.id}
        workspaceId={workspace.id}
      />,
    );
    await screen.findByTestId("selected-text-comment-attachment");
    expect(screen.getByLabelText("Message Mcode")).toBeVisible();
    rerender(
      <Composer
        threadId={thread.id}
        workspaceId={workspace.id}
        selectedTextCommentDeletion={transcriptComments[0]}
        onSelectedTextCommentDeletionConsumed={onSelectedTextCommentDeletionConsumed}
      />,
    );

    await waitFor(() => expect(useComposerDraftStore.getState().drafts[thread.id]?.selectedTextComments).toEqual([
      expect.objectContaining({ id: transcriptComments[1]!.id, displayNumber: 1 }),
    ]));
    expect(onSelectedTextCommentDeletionConsumed).toHaveBeenCalledOnce();
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

  it("uses workspace catalog scope while preparation is pending", async () => {
    seedPreparingComposerState();
    render(<Composer threadId="thread-placeholder" workspaceId="ws-1" />);

    await waitFor(() => {
      expect(lastFileAutocompleteOptions).toBeDefined();
      expect(lastSlashCommandOptions).toBeDefined();
    });

    expect(lastFileAutocompleteOptions).toEqual(expect.objectContaining({
      workspaceId: "ws-1",
      providerId: "codex",
      threadId: undefined,
      cwd: undefined,
    }));
    expect(lastSlashCommandOptions).toEqual(expect.objectContaining({
      providerId: "codex",
      workspaceId: "ws-1",
      threadId: undefined,
    }));
    expect(lastSlashCommandOptions).not.toHaveProperty("cwd");
  });

  it("keeps the selected worktree cwd for a normal new-thread composer", async () => {
    seedComposerState("existing-worktree");
    render(<Composer isNewThread workspaceId="ws-1" />);

    await waitFor(() => {
      expect(lastFileAutocompleteOptions).toBeDefined();
      expect(lastSlashCommandOptions).toBeDefined();
    });

    expect(lastFileAutocompleteOptions).toEqual(expect.objectContaining({
      workspaceId: "ws-1",
      threadId: undefined,
      cwd: "/repo/.worktrees/existing",
    }));
    expect(lastSlashCommandOptions).toEqual(expect.objectContaining({
      workspaceId: "ws-1",
      threadId: undefined,
    }));
  });

  it("switches catalog requests to the persisted thread and worktree after preparation resolves", async () => {
    seedPreparingComposerState();
    const { rerender } = render(<Composer threadId="thread-placeholder" workspaceId="ws-1" />);

    await waitFor(() => expect(lastFileAutocompleteOptions?.threadId).toBeUndefined());

    const persistedThread = createMockThread({
      id: "thread-persisted",
      workspace_id: "ws-1",
      mode: "worktree",
      provider: "codex",
      worktree_path: "/repo/.worktrees/persisted",
    });
    act(() => {
      useWorkspaceStore.setState({
        threads: [persistedThread],
        activeThreadId: persistedThread.id,
      });
    });
    rerender(<Composer threadId={persistedThread.id} workspaceId="ws-1" />);

    await waitFor(() => {
      expect(lastFileAutocompleteOptions).toMatchObject({
        workspaceId: "ws-1",
        threadId: persistedThread.id,
        cwd: persistedThread.worktree_path,
      });
      expect(lastSlashCommandOptions).toMatchObject({
        workspaceId: "ws-1",
        threadId: persistedThread.id,
      });
    });
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

  it("reports the optimistic startup row before the durable thread resolves", async () => {
    seedComposerState("worktree");
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => undefined),
    );
    const onThreadPreparing = vi.fn();
    render(
      <Composer
        isNewThread
        workspaceId="ws-1"
        onThreadPreparing={onThreadPreparing}
      />,
    );

    await typeAndSend();

    await waitFor(() => expect(onThreadPreparing).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        clientPreparing: true,
        clientStartupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    ));
  });

  it("reports a failed new-thread request after exposing its optimistic startup row", async () => {
    seedComposerState("worktree");
    (mockTransport.createAndSendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("thread creation failed"),
    );
    const onThreadPreparing = vi.fn();
    const onThreadCreationFailed = vi.fn();
    render(
      <Composer
        isNewThread
        workspaceId="ws-1"
        onThreadPreparing={onThreadPreparing}
        onThreadCreationFailed={onThreadCreationFailed}
      />,
    );

    await typeAndSend();

    await waitFor(() => expect(onThreadPreparing).toHaveBeenCalledOnce());
    expect(onThreadCreationFailed).toHaveBeenCalledOnce();
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

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Message Mcode"), "Fix the preview");
    await user.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalled());

    expect(lastComposerText).toBe("");
    expect(screen.queryByTestId("composer-annotation-bundle")).not.toBeInTheDocument();
    expect(usePreviewAnnotationStore.getState().byThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewAnnotationStore.getState().diffByThread[thread.id] ?? []).toEqual([]);
    expect(usePreviewDesignModeStore.getState().modes[thread.id]).toBe(false);
  });

  it("restores the draft when existing-thread transport fails", async () => {
    const workspace = createMockWorkspace({ id: "ws-1", is_git_repo: true });
    const thread = createMockThread({ id: "thread-restore-draft", workspace_id: "ws-1" });
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
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("transport unavailable"),
    );

    render(<Composer threadId={thread.id} workspaceId="ws-1" />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Message Mcode"), "Retry this message");
    await user.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        level: "error",
        title: "Could not send message",
        message: "Message dispatch failed",
      }),
    ));
    expect(lastComposerText).toBe("Retry this message");
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
      handleAgentEvent({
        type: "ended",
        threadId: thread.id,
        turnExecutionId: "exec-b",
        outcome: "completed",
      } as AgentEvent);
    });
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
  });

  it("keeps Continue hidden until a stopped thread is truly idle", () => {
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
    resetThreadStoreForTests({ currentThreadId: thread.id });
    useThreadStore.setState({
      records: seedThreadRecord(thread.id, { runtimePhase: "finalizing", turnExecutionId: "exec-stop" }),
      pendingStopCounts: { [thread.id]: 1 },
    });
    useQueueStore.getState().enqueue(thread.id, {
      content: "Continue after Stop",
      displayContent: "Continue after Stop",
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
    });

    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);

    expect(screen.queryByRole("button", { name: "Send next queued message" })).not.toBeInTheDocument();

    act(() => {
      useThreadStore.setState({ pendingStopCounts: {} });
    });
    expect(screen.queryByRole("button", { name: "Send next queued message" })).not.toBeInTheDocument();

    act(() => {
      useThreadStore.setState({
        records: seedThreadRecord(thread.id, { runtimePhase: "cancelled" }),
      });
    });
    expect(screen.getByRole("button", { name: "Send next queued message" })).toBeInTheDocument();
  });

  it("persists a pathless image before sending its durable attachment metadata", async () => {
    const workspace = createMockWorkspace({ id: "ws-pathless", is_git_repo: true });
    const thread = createMockThread({ id: "thread-pathless", workspace_id: workspace.id });
    const selectedImage = new File(
      [new Uint8Array([137, 80, 78, 71])],
      "selected-image.png",
      { type: "image/png" },
    );
    const durableAttachment = {
      id: "attachment-persisted-image",
      name: "stored-image.png",
      mimeType: "image/png",
      sizeBytes: 4,
      sourcePath: "C:\\mcode-data\\attachments\\attachment-persisted-image.png",
    };
    let resolvePersistence: (value: typeof durableAttachment) => void = () => undefined;
    const persistence = new Promise<typeof durableAttachment>((resolve) => {
      resolvePersistence = resolve;
    });
    const persistedBytes: Uint8Array[] = [];
    const saveClipboardFile = vi.fn((bytes: Uint8Array) => {
      persistedBytes.push(bytes);
      return persistence;
    });
    URL.createObjectURL = vi.fn(() => "blob:stored-image-preview");
    URL.revokeObjectURL = vi.fn();
    window.desktopBridge = {
      getPathForFile: () => null,
      saveClipboardFile,
    } as unknown as typeof window.desktopBridge;
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
      currentThreadId: thread.id,
      records: seedThreadRecord(thread.id),
    });

    const user = userEvent.setup();
    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);
    await user.type(screen.getByLabelText("Message Mcode"), "Inspect this image");
    await user.upload(screen.getByTestId("composer-attachment-input"), selectedImage);

    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(1));
    expect(Array.from(persistedBytes[0]!)).toEqual([137, 80, 78, 71]);
    expect(saveClipboardFile).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "image/png",
      "selected-image.png",
    );

    resolvePersistence(durableAttachment);

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Preview image stored-image.png" })).toHaveAttribute(
        "src",
        "blob:stored-image-preview",
      );
    });
    await user.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1));
    const sentCommand = (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentCommand.attachments).toEqual([durableAttachment]);
    expect(getTestThreadMessages(thread.id).at(-1)?.attachments).toEqual([
      {
        id: "attachment-persisted-image",
        name: "stored-image.png",
        mimeType: "image/png",
        sizeBytes: 4,
      },
    ]);
  });

  it("waits for pathless image persistence before sending", async () => {
    const workspace = createMockWorkspace({ id: "ws-pathless-wait", is_git_repo: true });
    const thread = createMockThread({ id: "thread-pathless-wait", workspace_id: workspace.id });
    const selectedImage = new File([new Uint8Array([4, 5, 6])], "wait-image.png", {
      type: "image/png",
    });
    const durableAttachment = {
      id: "attachment-wait-image",
      name: "stored-wait-image.png",
      mimeType: "image/png",
      sizeBytes: 3,
      sourcePath: "C:\\mcode-data\\attachments\\attachment-wait-image.png",
    };
    let resolvePersistence: (value: typeof durableAttachment) => void = () => undefined;
    const persistence = new Promise<typeof durableAttachment>((resolve) => {
      resolvePersistence = resolve;
    });
    const saveClipboardFile = vi.fn(() => persistence);
    URL.createObjectURL = vi.fn(() => "blob:wait-image-preview");
    URL.revokeObjectURL = vi.fn();
    window.desktopBridge = {
      getPathForFile: () => null,
      saveClipboardFile,
    } as unknown as typeof window.desktopBridge;
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
      currentThreadId: thread.id,
      records: seedThreadRecord(thread.id),
    });

    const user = userEvent.setup();
    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);
    await user.type(screen.getByLabelText("Message Mcode"), "Wait for the image");
    await user.upload(screen.getByTestId("composer-attachment-input"), selectedImage);
    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(1));

    await user.click(screen.getByLabelText("Send message"));
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();

    resolvePersistence(durableAttachment);

    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1));
    const sentCommand = (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentCommand.attachments).toEqual([durableAttachment]);
  });

  it("does not send a pathless image when attachment persistence fails", async () => {
    const workspace = createMockWorkspace({ id: "ws-pathless-failure", is_git_repo: true });
    const thread = createMockThread({ id: "thread-pathless-failure", workspace_id: workspace.id });
    const selectedImage = new File([new Uint8Array([1, 2, 3])], "retry-image.png", {
      type: "image/png",
    });
    let rejectPersistence: (reason: Error) => void = () => undefined;
    const persistence = new Promise<never>((_resolve, reject) => {
      rejectPersistence = reject;
    });
    const saveClipboardFile = vi.fn(() => persistence);
    URL.createObjectURL = vi.fn(() => "blob:retry-image-preview");
    URL.revokeObjectURL = vi.fn();
    window.desktopBridge = {
      getPathForFile: () => null,
      saveClipboardFile,
    } as unknown as typeof window.desktopBridge;
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
      currentThreadId: thread.id,
      records: seedThreadRecord(thread.id),
    });

    const user = userEvent.setup();
    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);
    await user.type(screen.getByLabelText("Message Mcode"), "Do not send without the image");
    await user.upload(screen.getByTestId("composer-attachment-input"), selectedImage);
    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(1));

    await user.click(screen.getByLabelText("Send message"));
    rejectPersistence(new Error("disk unavailable"));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          level: "error",
          title: "Could not attach file",
          message: "The file was not saved. Try again.",
        }),
      ]);
    });
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(getTestThreadMessages(thread.id)).toEqual([]);
    expect(screen.getByTestId("attachment-preview")).toBeEmptyDOMElement();
  });

  it("reserves capacity for delayed pathless image persistence", async () => {
    const workspace = createMockWorkspace({ id: "ws-pathless-capacity", is_git_repo: true });
    const thread = createMockThread({ id: "thread-pathless-capacity", workspace_id: workspace.id });
    const selectedImages = Array.from(
      { length: 12 },
      (_, index) =>
        new File([new Uint8Array([index])], `capacity-${String(index + 1).padStart(2, "0")}.png`, {
          type: "image/png",
        }),
    );
    const resolvePersistenceByName = new Map<
      string,
      (value: {
        id: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
        sourcePath: string;
      }) => void
    >();
    const saveClipboardFile = vi.fn(
      (_bytes: Uint8Array, _mimeType: string, name: string) =>
        new Promise<{
          id: string;
          name: string;
          mimeType: string;
          sizeBytes: number;
          sourcePath: string;
        }>((resolve) => {
          resolvePersistenceByName.set(name, resolve);
        }),
    );
    URL.createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
    URL.revokeObjectURL = vi.fn();
    window.desktopBridge = {
      getPathForFile: () => null,
      saveClipboardFile,
    } as unknown as typeof window.desktopBridge;
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
      currentThreadId: thread.id,
      records: seedThreadRecord(thread.id),
    });

    const user = userEvent.setup();
    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);
    const attachmentInput = screen.getByTestId("composer-attachment-input");
    for (const image of selectedImages.slice(0, 6)) {
      await user.upload(attachmentInput, image);
    }
    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(6));
    for (const image of selectedImages.slice(6)) {
      await user.upload(attachmentInput, image);
    }

    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(10));
    expect(saveClipboardFile).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "image/png",
      "capacity-10.png",
    );
    expect(saveClipboardFile).not.toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "image/png",
      "capacity-11.png",
    );
    expect(saveClipboardFile).not.toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "image/png",
      "capacity-12.png",
    );

    for (let index = 1; index <= 10; index++) {
      const name = `capacity-${String(index).padStart(2, "0")}.png`;
      resolvePersistenceByName.get(name)!({
        id: `attachment-${index}`,
        name,
        mimeType: "image/png",
        sizeBytes: 1,
        sourcePath: `C:\\mcode-data\\attachments\\${name}`,
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview")).toHaveTextContent("capacity-10.png");
    });
    expect(screen.getByTestId("attachment-preview")).not.toHaveTextContent("capacity-11.png");
    expect(screen.getByTestId("attachment-preview")).not.toHaveTextContent("capacity-12.png");
  });

  it("discards delayed pathless persistence after replacing or cancelling a queued edit", async () => {
    const workspace = createMockWorkspace({ id: "ws-pathless-edit", is_git_repo: true });
    const thread = createMockThread({ id: "thread-pathless-edit", workspace_id: workspace.id });
    const firstImage = new File([new Uint8Array([10])], "first-delayed.png", {
      type: "image/png",
    });
    const secondImage = new File([new Uint8Array([11])], "second-delayed.png", {
      type: "image/png",
    });
    let resolveFirstPersistence: (value: {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    }) => void = () => undefined;
    let resolveSecondPersistence: (value: {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    }) => void = () => undefined;
    const firstPersistence = new Promise<{
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    }>((resolve) => {
      resolveFirstPersistence = resolve;
    });
    const secondPersistence = new Promise<{
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sourcePath: string;
    }>((resolve) => {
      resolveSecondPersistence = resolve;
    });
    const saveClipboardFile = vi.fn((_bytes: Uint8Array, _mimeType: string, name: string) =>
      name === "first-delayed.png" ? firstPersistence : secondPersistence,
    );
    URL.createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
    URL.revokeObjectURL = vi.fn();
    window.desktopBridge = {
      getPathForFile: () => null,
      saveClipboardFile,
    } as unknown as typeof window.desktopBridge;
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
      currentThreadId: thread.id,
      records: seedThreadRecord(thread.id),
    });
    useQueueStore.getState().enqueue(thread.id, {
      content: "Message A",
      displayContent: "Message A",
      mentions: undefined,
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

    const user = userEvent.setup();
    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);
    await user.click(screen.getByLabelText("Edit Message A"));
    await user.upload(screen.getByTestId("composer-attachment-input"), firstImage);
    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(1));
    await user.click(screen.getByLabelText("Edit Message B"));

    await act(async () => {
      resolveFirstPersistence({
        id: "attachment-first-delayed",
        name: "stored-first-delayed.png",
        mimeType: "image/png",
        sizeBytes: 1,
        sourcePath: "C:\\mcode-data\\attachments\\stored-first-delayed.png",
      });
      await firstPersistence;
    });

    expect(screen.getByTestId("attachment-preview")).toBeEmptyDOMElement();
    await user.upload(screen.getByTestId("composer-attachment-input"), secondImage);
    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(2));
    await user.click(
      screen.getByLabelText("Discard edits and restore the original queued message"),
    );

    await act(async () => {
      resolveSecondPersistence({
        id: "attachment-second-delayed",
        name: "stored-second-delayed.png",
        mimeType: "image/png",
        sizeBytes: 1,
        sourcePath: "C:\\mcode-data\\attachments\\stored-second-delayed.png",
      });
      await secondPersistence;
    });

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("attachment-preview")).toBeEmptyDOMElement();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("restores a queued goal when its edit is discarded", async () => {
    const workspace = createMockWorkspace({ id: "ws-queued-goal", is_git_repo: true });
    const thread = createMockThread({ id: "thread-queued-goal", workspace_id: workspace.id });
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
      currentThreadId: thread.id,
      records: seedThreadRecord(thread.id),
    });
    useQueueStore.getState().enqueue(thread.id, {
      content: "Finish the migration",
      displayContent: "Finish the migration",
      mentions: undefined,
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
      goalObjective: "Ship the migration safely",
    });

    const user = userEvent.setup();
    render(<Composer threadId={thread.id} workspaceId={workspace.id} />);
    await user.click(screen.getByLabelText("Edit Finish the migration"));
    await user.click(
      screen.getByLabelText("Discard edits and restore the original queued message"),
    );

    expect(useQueueStore.getState().queues[thread.id]).toEqual([
      expect.objectContaining({
        content: "Finish the migration",
        goalObjective: "Ship the migration safely",
      }),
    ]);
  });

  it("discards pathless persistence when the composer switches threads", async () => {
    const workspace = createMockWorkspace({ id: "ws-pathless-switch", is_git_repo: true });
    const threadA = createMockThread({ id: "thread-pathless-a", workspace_id: workspace.id });
    const threadB = createMockThread({ id: "thread-pathless-b", workspace_id: workspace.id });
    const selectedImage = new File([new Uint8Array([7, 8, 9])], "switch-image.png", {
      type: "image/png",
    });
    const durableAttachment = {
      id: "attachment-switch-image",
      name: "stored-switch-image.png",
      mimeType: "image/png",
      sizeBytes: 3,
      sourcePath: "C:\\mcode-data\\attachments\\attachment-switch-image.png",
    };
    let resolvePersistence: (value: typeof durableAttachment) => void = () => undefined;
    const persistence = new Promise<typeof durableAttachment>((resolve) => {
      resolvePersistence = resolve;
    });
    const saveClipboardFile = vi.fn(() => persistence);
    URL.createObjectURL = vi.fn(() => "blob:switch-image-preview");
    URL.revokeObjectURL = vi.fn();
    window.desktopBridge = {
      getPathForFile: () => null,
      saveClipboardFile,
    } as unknown as typeof window.desktopBridge;
    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      threads: [threadA, threadB],
      activeThreadId: threadA.id,
      branches: [branch("main", true)],
      newThreadMode: "direct",
      newThreadBranch: "main",
      selectedWorktree: null,
    });
    resetThreadStoreForTests({
      currentThreadId: threadA.id,
      records: seedThreadRecord(threadA.id),
    });

    const user = userEvent.setup();
    const { rerender } = render(<Composer threadId={threadA.id} workspaceId={workspace.id} />);
    await user.type(screen.getByLabelText("Message Mcode"), "Send from thread A");
    await user.upload(screen.getByTestId("composer-attachment-input"), selectedImage);
    await waitFor(() => expect(saveClipboardFile).toHaveBeenCalledTimes(1));
    await user.click(screen.getByLabelText("Send message"));
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();

    useWorkspaceStore.setState({ activeThreadId: threadB.id });
    useThreadStore.setState({
      currentThreadId: threadB.id,
      records: seedThreadRecord(threadB.id),
    });
    rerender(<Composer threadId={threadB.id} workspaceId={workspace.id} />);

    await act(async () => {
      resolvePersistence(durableAttachment);
      await persistence;
    });

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(getTestThreadMessages(threadA.id)).toEqual([]);
    expect(getTestThreadMessages(threadB.id)).toEqual([]);
    expect(screen.getByTestId("attachment-preview")).toBeEmptyDOMElement();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
