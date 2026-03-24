import { useState, useRef, useCallback, useEffect } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { PermissionMode, InteractionMode, AttachmentMeta } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES, getTransport } from "@/transport";
import {
  ArrowUp,
  Square,
  MessageSquare,
  FileEdit,
  Lock,
  Unlock,
  ChevronDown,
  Loader2,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getDefaultModel } from "@/lib/model-registry";
import { ModelSelector } from "./ModelSelector";
import { ModeSelector } from "./ModeSelector";
import type { ComposerMode } from "./ModeSelector";
import { BranchPicker } from "./BranchPicker";
import { NamingModeSelector } from "./NamingModeSelector";
import { BranchNameInput } from "./BranchNameInput";
import { WorktreePicker } from "./WorktreePicker";
import { AttachmentPreview } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";
import { useFileAutocomplete, clearFileListCache } from "./useFileAutocomplete";
import { useFileTagPopup, FileTagPopup } from "./FileTagPopup";
import { TextOverlay } from "./TextOverlay";
import { extractFileRefs, buildInjectedMessage } from "@/lib/file-tags";
import { useSlashCommand } from "./useSlashCommand";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { QueuePopover } from "./QueuePopover";
import { useQueueStore } from "@/stores/queueStore";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SUPPORTED_FILE_TYPES = new Set(["application/pdf", "text/plain"]);
const ALL_SUPPORTED_TYPES = new Set([...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_FILE_TYPES]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 32 * 1024 * 1024;
const MAX_TEXT_SIZE = 1 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

interface ComposerProps {
  threadId?: string;
  isNewThread?: boolean;
  workspaceId?: string;
}

type AccessMode = PermissionMode;
type ReasoningLevel = "low" | "medium" | "high";

/**
 * Main message composer with model/mode selectors and branch controls.
 *
 * Status bar layout varies by mode:
 * - **Direct:** `[Local v]` … `[From branch v]`
 * - **Worktree:** `[Worktree v]` … `[From branch v] [Auto v] [branch-name]`
 * - **Existing worktree:** `[Worktree v]` … `[Select worktree v]`
 * - **Locked (existing thread):** read-only branch badge
 */
export function Composer({ threadId, isNewThread, workspaceId }: ComposerProps) {
  const [input, setInput] = useState("");
  const [modelId, setModelId] = useState(getDefaultModel().id);
  const [reasoning, setReasoning] = useState<ReasoningLevel>("high");
  const [mode, setMode] = useState<InteractionMode>(INTERACTION_MODES.CHAT);
  const [access, setAccess] = useState<AccessMode>(PERMISSION_MODES.FULL);
  const [showReasoningPicker, setShowReasoningPicker] = useState(false);
  const [composerMode, setComposerModeLocal] = useState<ComposerMode>("direct");
  const [preparingWorktree, setPreparingWorktree] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [taggedFiles, setTaggedFiles] = useState<Set<string>>(new Set());
  const overlayRef = useRef<HTMLDivElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fileAutocomplete = useFileAutocomplete({
    workspaceId,
    threadId,
  });

  const handleFileSelect = (filePath: string) => {
    const selected = fileAutocomplete.selectFile(filePath);
    const before = input.slice(0, fileAutocomplete.triggerStart);
    const after = input.slice(
      fileAutocomplete.triggerStart + 1 + fileAutocomplete.query.length,
    );
    const newInput = `${before}@${selected} ${after}`;
    setInput(newInput);
    setTaggedFiles((prev) => new Set([...prev, selected]));

    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const cursorPos = before.length + 1 + selected.length + 1;
        ta.setSelectionRange(cursorPos, cursorPos);
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
      }
    });
  };

  const filePopup = useFileTagPopup({
    files: fileAutocomplete.filteredFiles,
    query: fileAutocomplete.query,
    isOpen: fileAutocomplete.isOpen,
    onSelect: handleFileSelect,
    onDismiss: fileAutocomplete.dismiss,
  });
  const sendMessage = useThreadStore((s) => s.sendMessage);
  const stopAgent = useThreadStore((s) => s.stopAgent);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const getThreadSettings = useThreadStore((s) => s.getThreadSettings);
  const setThreadSettings = useThreadStore((s) => s.setThreadSettings);
  const isAgentRunning = threadId ? runningThreadIds.has(threadId) : false;

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspacePath = workspaces.find((w) => w.id === workspaceId)?.path;

  const threads = useWorkspaceStore((s) => s.threads);
  const activeThread = threadId ? threads.find((t) => t.id === threadId) : undefined;

  const branches = useWorkspaceStore((s) => s.branches);
  const branchesLoading = useWorkspaceStore((s) => s.branchesLoading);
  const newThreadMode = useWorkspaceStore((s) => s.newThreadMode);
  const newThreadBranch = useWorkspaceStore((s) => s.newThreadBranch);
  const loadBranches = useWorkspaceStore((s) => s.loadBranches);
  const setNewThreadMode = useWorkspaceStore((s) => s.setNewThreadMode);
  const setNewThreadBranch = useWorkspaceStore((s) => s.setNewThreadBranch);

  const slashCommand = useSlashCommand({
    textareaRef,
    cwd: workspacePath,
    onMcodeCommand: (action) => {
      if (action === "toggle-plan") {
        const next =
          mode === INTERACTION_MODES.PLAN
            ? INTERACTION_MODES.CHAT
            : INTERACTION_MODES.PLAN;
        setMode(next);
        if (threadId) setThreadSettings(threadId, { interactionMode: next });
      }
    },
  });

  const worktrees = useWorkspaceStore((s) => s.worktrees);
  const worktreesLoading = useWorkspaceStore((s) => s.worktreesLoading);
  const namingMode = useWorkspaceStore((s) => s.namingMode);
  const customBranchName = useWorkspaceStore((s) => s.customBranchName);
  const autoPreviewBranch = useWorkspaceStore((s) => s.autoPreviewBranch);
  const selectedWorktree = useWorkspaceStore((s) => s.selectedWorktree);
  const loadWorktrees = useWorkspaceStore((s) => s.loadWorktrees);
  const setNamingMode = useWorkspaceStore((s) => s.setNamingMode);
  const setCustomBranchName = useWorkspaceStore((s) => s.setCustomBranchName);
  const setSelectedWorktree = useWorkspaceStore((s) => s.setSelectedWorktree);

  // Sync modelId with the active thread's locked model when switching threads
  useEffect(() => {
    if (activeThread?.model) {
      setModelId(activeThread.model);
    }
  }, [activeThread?.model]);

  // Sync access mode and interaction mode from per-thread settings
  useEffect(() => {
    if (threadId) {
      const settings = getThreadSettings(threadId);
      setAccess(settings.permissionMode);
      setMode(settings.interactionMode);
    }
  }, [threadId, getThreadSettings]);

  // Combined setter that keeps local + store in sync
  const setComposerMode = useCallback(
    (mode: ComposerMode) => {
      setComposerModeLocal(mode);
      setNewThreadMode(mode);
      if (mode === "existing-worktree" && workspaceId) {
        loadWorktrees(workspaceId);
      }
    },
    [setNewThreadMode, loadWorktrees, workspaceId],
  );

  // Sync composerMode with thread's persisted mode when switching threads
  useEffect(() => {
    const mode = activeThread?.mode === "worktree" ? "worktree" : "direct";
    setComposerModeLocal(mode);
    setNewThreadMode(mode);
  }, [activeThread?.mode, setNewThreadMode]);

  // Load branches when entering worktree mode (or any new thread)
  useEffect(() => {
    if (isNewThread && workspaceId && branches.length === 0) {
      loadBranches(workspaceId);
    }
  }, [isNewThread, workspaceId, branches.length, loadBranches]);

  // Auto-select current branch if none selected
  useEffect(() => {
    if (isNewThread && !newThreadBranch && branches.length > 0) {
      const current = branches.find((b) => b.isCurrent);
      if (current) setNewThreadBranch(current.name);
    }
  }, [isNewThread, newThreadBranch, branches, setNewThreadBranch]);

  const hasContent = input.trim().length > 0 || attachments.length > 0;

  // Full lock when agent running, provider lock when thread has a model
  const isModelFullyLocked = isAgentRunning;
  const isProviderLocked = !isNewThread && activeThread?.model != null;

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = () => {
      setShowReasoningPicker(false);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const handleStop = useCallback(() => {
    if (threadId) {
      stopAgent(threadId);
    }
  }, [threadId, stopAgent]);

  const getMaxSize = (mimeType: string): number => {
    if (SUPPORTED_IMAGE_TYPES.has(mimeType)) return MAX_IMAGE_SIZE;
    if (mimeType === "application/pdf") return MAX_PDF_SIZE;
    if (mimeType === "text/plain") return MAX_TEXT_SIZE;
    return 0;
  };

  const addFiles = useCallback((files: File[], filePaths?: (string | null)[]) => {
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length;
      if (remaining <= 0) return prev;

      const newAttachments: PendingAttachment[] = [];
      for (let i = 0; i < Math.min(files.length, remaining); i++) {
        const file = files[i];
        if (!ALL_SUPPORTED_TYPES.has(file.type)) continue;
        if (file.size > getMaxSize(file.type)) continue;

        const previewUrl = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : "";

        newAttachments.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl,
          filePath: filePaths?.[i] || null,
        });
      }

      return [...prev, ...newAttachments];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));

    if (imageFiles.length > 0) {
      e.preventDefault();
      const api = window.electronAPI;
      if (api?.getPathForFile) {
        // getPathForFile returns "" for clipboard blobs (no real file on disk).
        // Use || to treat empty strings as null, falling through to readClipboardImage.
        const paths = imageFiles.map((f) => {
          try { return api.getPathForFile(f) || null; } catch { return null; }
        });
        const hasRealPaths = paths.some((p) => p !== null);
        if (hasRealPaths) {
          addFiles(imageFiles, paths);
        } else {
          // Clipboard images have no file path; use main process clipboard reader
          try {
            const meta = await getTransport().readClipboardImage();
            if (meta) {
              setAttachments((prev) => {
                if (prev.length >= MAX_ATTACHMENTS) return prev;
                const previewUrl = imageFiles[0] ? URL.createObjectURL(imageFiles[0]) : "";
                return [...prev, {
                  id: meta.id,
                  name: meta.name,
                  mimeType: meta.mimeType,
                  sizeBytes: meta.sizeBytes,
                  previewUrl,
                  filePath: meta.sourcePath,
                }];
              });
            }
          } catch {
            addFiles(imageFiles);
          }
        }
      } else {
        try {
          const meta = await getTransport().readClipboardImage();
          if (meta) {
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              const previewUrl = imageFiles[0] ? URL.createObjectURL(imageFiles[0]) : "";
              return [...prev, {
                id: meta.id,
                name: meta.name,
                mimeType: meta.mimeType,
                sizeBytes: meta.sizeBytes,
                previewUrl,
                filePath: meta.sourcePath,
              }];
            });
          }
        } catch {
          addFiles(imageFiles);
        }
      }
    }
  }, [addFiles]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const supported = files.filter((f) => ALL_SUPPORTED_TYPES.has(f.type));
    if (supported.length === 0) return;
    const api = window.electronAPI;
    const paths = supported.map((f) => {
      try { return api?.getPathForFile?.(f) ?? null; } catch { return null; }
    });
    addFiles(supported, paths);
    textareaRef.current?.focus();
  }, [addFiles]);

  /** Resolve @file tags into injected content. */
  const injectFileContent = useCallback(async (trimmed: string): Promise<{ content: string; display?: string }> => {
    const refs = extractFileRefs(trimmed);
    if (refs.length > 0 && workspaceId) {
      try {
        const transport = getTransport();
        const fileContents = await Promise.all(
          refs.map(async (path) => {
            try {
              const content = await transport.readFileContent(workspaceId, path, threadId);
              return { path, content };
            } catch { return null; }
          }),
        );
        const validFiles = fileContents.filter(
          (f): f is { path: string; content: string } => f !== null,
        );
        const injected = buildInjectedMessage(trimmed, validFiles);
        return { content: injected, display: injected !== trimmed ? trimmed : undefined };
      } catch { /* fall through */ }
    }
    return { content: trimmed };
  }, [workspaceId, threadId]);

  /** Collect attachment metadata and revoke preview URLs. */
  const collectAndClearAttachments = useCallback((): AttachmentMeta[] => {
    const metas: AttachmentMeta[] = attachments
      .filter((a) => a.filePath != null)
      .map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        sourcePath: a.filePath!,
      }));
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setAttachments([]);
    return metas;
  }, [attachments]);

  const handleSend = useCallback(async () => {
    if (!hasContent) return;
    const trimmed = input.trim();

    // ---- Queue path: agent is running on this thread ----
    if (isAgentRunning && threadId) {
      const { content, display } = await injectFileContent(trimmed);
      const currentAttachments = collectAndClearAttachments();

      useQueueStore.getState().enqueue(threadId, {
        content,
        displayContent: display,
        attachments: currentAttachments,
        model: modelId,
        permissionMode: access,
      });

      setInput("");
      setTaggedFiles(new Set());
      textareaRef.current?.focus();
      return;
    }

    // ---- Normal send path ----
    const { content: messageContent, display: displayContent } = await injectFileContent(trimmed);

    // Validate worktree mode requirements
    if (isNewThread && newThreadMode === "worktree" && namingMode === "custom" && !customBranchName.trim()) {
      return;
    }
    if (isNewThread && newThreadMode === "existing-worktree" && !selectedWorktree) {
      return;
    }

    // Checkout confirmation for local mode when a different branch is selected
    if (isNewThread && newThreadMode === "direct" && newThreadBranch && workspaceId) {
      const currentBranch = await useWorkspaceStore.getState().getCurrentBranch(workspaceId);
      if (newThreadBranch !== currentBranch) {
        const confirmed = window.confirm(
          `You're on "${currentBranch}" but selected "${newThreadBranch}". Switch to "${newThreadBranch}"? This will checkout the branch.`,
        );
        if (!confirmed) return;
        await useWorkspaceStore.getState().checkoutBranch(workspaceId, newThreadBranch);
        clearFileListCache(workspaceId);
      }
    }

    setInput("");
    setTaggedFiles(new Set());
    const currentAttachments = collectAndClearAttachments();

    if (isNewThread && workspaceId) {
      if (newThreadMode === "worktree" || newThreadMode === "existing-worktree") {
        setPreparingWorktree(true);
      }
      try {
        await useWorkspaceStore.getState().createAndSendMessage(messageContent, modelId, access, currentAttachments.length > 0 ? currentAttachments : undefined);
      } finally {
        setPreparingWorktree(false);
      }
    } else if (threadId) {
      await sendMessage(threadId, messageContent, modelId, access, currentAttachments.length > 0 ? currentAttachments : undefined, displayContent);
    }
    textareaRef.current?.focus();
  // taggedFiles omitted: handleSend only clears it via setTaggedFiles (stable setter), never reads the value.
  }, [input, attachments, isAgentRunning, isNewThread, newThreadMode, newThreadBranch, workspaceId, threadId, sendMessage, modelId, access, namingMode, customBranchName, selectedWorktree, injectFileContent, collectAndClearAttachments]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the file tag popup handle keys when open
    if (filePopup.handleKeyDown(e)) return;

    // When the slash command popup is open, intercept Enter/Tab for selection
    // BEFORE any other handler sees them.
    if (slashCommand.isOpen) {
      if (e.key === "Enter" || e.key === "Tab") {
        const cmd = slashCommand.items[slashCommand.selectedIndex];
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          slashCommand.onSelect(cmd, setInput);
          return;
        }
      }
      // ArrowUp/ArrowDown/Escape: delegate to hook
      slashCommand.onKeyDown(e);
      if (e.defaultPrevented) return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setInput(newValue);
    slashCommand.onInputChange(newValue);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";

    // Sync overlay scroll
    if (overlayRef.current) {
      overlayRef.current.scrollTop = el.scrollTop;
    }

    // Update autocomplete state
    fileAutocomplete.handleInputChange(newValue, el.selectionStart ?? newValue.length);

    // Update tagged files: remove any that are no longer in the text
    const currentRefs = new Set(extractFileRefs(newValue));
    setTaggedFiles((prev) => {
      const next = new Set([...prev].filter((f) => currentRefs.has(f)));
      return next.size === prev.size ? prev : next;
    });
  };

  const toast = useQueueStore((s) => s.toast);

  return (
    <div className="relative border-t border-border px-4 py-3">
      {/* Queue toast */}
      {toast && (
        <div className="pointer-events-none absolute -top-8 right-4 z-20 flex items-center gap-1.5 rounded-full bg-card/90 px-3 py-1 text-[11px] text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
          <Check size={10} className="text-primary" />
          {toast}
        </div>
      )}

      {/* Main composer container - dark bg, rounded */}
      <div
        className={cn(
          "relative rounded-xl bg-muted/50 ring-1 ring-border focus-within:ring-primary/50",
          isDragOver && "ring-2 ring-primary"
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Textarea with overlay */}
        <div className="relative">
          <TextOverlay ref={overlayRef} text={input} validRefs={taggedFiles} knownCommands={slashCommand.allCommands} />
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={(e) => {
              if (overlayRef.current) {
                overlayRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            placeholder={isAgentRunning ? "Queue a follow-up..." : "Ask for follow-up changes or attach images"}
            rows={1}
            className="relative z-10 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <FileTagPopup
            files={fileAutocomplete.filteredFiles}
            isOpen={fileAutocomplete.isOpen}
            onSelect={handleFileSelect}
            listRef={filePopup.listRef}
          />
        </div>

        {/* Attachment previews */}
        <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />

        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 backdrop-blur-sm">
            <span className="text-sm font-medium text-primary">Drop files here</span>
          </div>
        )}

        {/* Controls row - inside the container */}
        <div className="flex items-center gap-1 px-3 pb-2">
          {/* Model picker */}
          <ModelSelector
            selectedModelId={modelId}
            onSelect={setModelId}
            locked={isModelFullyLocked}
            providerLocked={isProviderLocked}
          />

          <span className="text-border">|</span>

          {/* Reasoning level */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowReasoningPicker(!showReasoningPicker);
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {reasoning.charAt(0).toUpperCase() + reasoning.slice(1)}
              <ChevronDown size={10} />
            </button>
            {showReasoningPicker && (
              <div className="absolute bottom-full left-0 mb-1 rounded-md border border-border bg-card p-1 shadow-lg">
                {(["low", "medium", "high"] as const).map((level) => (
                  <button
                    key={level}
                    onClick={(e) => {
                      e.stopPropagation();
                      setReasoning(level);
                      setShowReasoningPicker(false);
                    }}
                    className={cn(
                      "flex w-full items-center rounded px-3 py-1.5 text-xs capitalize",
                      reasoning === level
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                  >
                    {level}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="text-border">|</span>

          {/* Chat / Plan toggle */}
          <button
            onClick={() => {
              const next = mode === INTERACTION_MODES.CHAT ? INTERACTION_MODES.PLAN : INTERACTION_MODES.CHAT;
              setMode(next);
              if (threadId) setThreadSettings(threadId, { interactionMode: next });
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {mode === INTERACTION_MODES.CHAT ? (
              <>
                <MessageSquare size={12} />
                Chat
              </>
            ) : (
              <>
                <FileEdit size={12} />
                Plan
              </>
            )}
          </button>

          <span className="text-border">|</span>

          {/* Full access / Supervised toggle */}
          <button
            onClick={() => {
              const next: AccessMode = access === PERMISSION_MODES.FULL ? PERMISSION_MODES.SUPERVISED : PERMISSION_MODES.FULL;
              setAccess(next);
              if (threadId) setThreadSettings(threadId, { permissionMode: next });
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {access === PERMISSION_MODES.FULL ? (
              <>
                <Unlock size={12} />
                Full access
              </>
            ) : (
              <>
                <Lock size={12} />
                Supervised
              </>
            )}
          </button>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Preparing worktree indicator */}
          {preparingWorktree && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Preparing worktree...
            </span>
          )}

          {/* Inline stop button: visible when agent running AND user has input */}
          {isAgentRunning && hasContent && (
            <button
              onClick={handleStop}
              className="rounded-md p-1.5 text-destructive/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="Stop agent"
            >
              <Square size={11} />
            </button>
          )}

          {/* Queue badge + popover */}
          {threadId && (
            <QueuePopover
              threadId={threadId}
              isAgentRunning={isAgentRunning}
              onResume={() => {
                const next = useQueueStore.getState().dequeueNext(threadId);
                if (next) {
                  sendMessage(threadId, next.content, next.model, next.permissionMode,
                    next.attachments.length > 0 ? next.attachments : undefined, next.displayContent);
                }
              }}
            />
          )}

          {/* Send / Queue / Stop button */}
          <button
            onClick={
              preparingWorktree
                ? undefined
                : isAgentRunning && hasContent
                  ? handleSend
                  : isAgentRunning
                    ? handleStop
                    : handleSend
            }
            disabled={
              preparingWorktree ||
              (!isAgentRunning && !hasContent)
            }
            className={cn(
              "rounded-full p-2 transition-colors",
              preparingWorktree
                ? "bg-primary text-primary-foreground animate-spin"
                : isAgentRunning && hasContent
                  ? "bg-primary/60 text-primary-foreground hover:bg-primary/75"
                  : isAgentRunning
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : hasContent
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-muted text-muted-foreground opacity-40"
            )}
            title={
              isAgentRunning && hasContent
                ? "Queue message"
                : isAgentRunning
                  ? "Stop agent"
                  : "Send message"
            }
          >
            {preparingWorktree ? (
              <Loader2 size={14} />
            ) : isAgentRunning && hasContent ? (
              <ArrowUp size={14} />
            ) : isAgentRunning ? (
              <Square size={14} />
            ) : (
              <ArrowUp size={14} />
            )}
          </button>
        </div>
      </div>

      {/* Status bar - below the container */}
      <div className="flex items-center justify-between px-1 pt-1.5">
        <ModeSelector
          mode={composerMode}
          onModeChange={setComposerMode}
          locked={!isNewThread}
        />
        <div className="ml-auto flex items-center gap-1">
          {isNewThread ? (
            composerMode === "direct" ? (
              <BranchPicker
                branches={branches}
                selectedBranch={newThreadBranch || "main"}
                onSelect={setNewThreadBranch}
                loading={branchesLoading}
                locked={false}
              />
            ) : composerMode === "worktree" ? (
              <>
                <BranchPicker
                  branches={branches}
                  selectedBranch={newThreadBranch || "main"}
                  onSelect={setNewThreadBranch}
                  loading={branchesLoading}
                  locked={false}
                />
                <NamingModeSelector mode={namingMode} onModeChange={setNamingMode} />
                <BranchNameInput
                  namingMode={namingMode}
                  autoPreview={autoPreviewBranch}
                  customValue={customBranchName}
                  onCustomChange={setCustomBranchName}
                />
              </>
            ) : composerMode === "existing-worktree" ? (
              <WorktreePicker
                worktrees={worktrees}
                selectedPath={selectedWorktree?.path ?? ""}
                onSelect={setSelectedWorktree}
                loading={worktreesLoading}
              />
            ) : null
          ) : activeThread?.branch ? (
            <BranchPicker
              branches={[]}
              selectedBranch={activeThread.branch}
              onSelect={() => {}}
              loading={false}
              locked={true}
            />
          ) : null}
        </div>
      </div>

      <SlashCommandPopup
        isOpen={slashCommand.isOpen}
        isLoading={slashCommand.isLoading}
        items={slashCommand.items}
        selectedIndex={slashCommand.selectedIndex}
        anchorRect={slashCommand.anchorRect}
        onSelect={(cmd) => slashCommand.onSelect(cmd, setInput)}
        onDismiss={slashCommand.onDismiss}
      />
    </div>
  );
}
