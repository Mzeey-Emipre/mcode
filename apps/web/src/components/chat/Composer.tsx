import { useState, useRef, useCallback, useEffect } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { PermissionMode, InteractionMode, AttachmentMeta } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES, getTransport } from "@/transport";
import {
  ArrowUp,
  MessageSquare,
  FileEdit,
  Lock,
  Unlock,
  ChevronDown,
  Loader2,
  Check,
  ListTodo,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getDefaultModelId, getDefaultReasoningLevel, findModelById, isMaxEffortModel, resolveThreadModelId, normalizeReasoningLevelForModel, DEFAULT_CONTEXT_WINDOW, findProviderForModel, getCodexReasoningLevels } from "@/lib/model-registry";
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
import { ComposerEditor, insertMentionNode, insertSlashCommandNode } from "./lexical";
import { AgentStatusBar } from "./AgentStatusBar";
import { useTaskStore } from "@/stores/taskStore";
import { useDiffStore } from "@/stores/diffStore";
import { extractFileRefs, buildInjectedMessage } from "@/lib/file-tags";
import { useSlashCommand } from "./useSlashCommand";
import type { Command } from "./useSlashCommand";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { type LexicalEditor, $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { PrDetectedCard } from "./PrDetectedCard";
import type { PrDetail } from "@/transport/types";
import { QueuePopover } from "./QueuePopover";
import { ContextTracker } from "./ContextTracker";
import { CompactingBanner } from "./CompactingBanner";
import { useQueueStore } from "@/stores/queueStore";
import {
  classifyFile,
  isFileSupported,
  getMaxFileSize,
  inferMimeType,
  MAX_ATTACHMENTS,
} from "@mcode/contracts";
import type { ReasoningLevel } from "@mcode/contracts";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useSettingsStore } from "@/stores/settingsStore";

interface ComposerProps {
  threadId?: string;
  isNewThread?: boolean;
  workspaceId?: string;
}

type AccessMode = PermissionMode;

/** Tasks toggle button shown in the status bar only when the thread has tasks. */
function TasksToggle({ threadId }: { threadId?: string }) {
  const hasTasks = useTaskStore(
    (s) => !!(threadId && s.tasksByThread[threadId]?.length),
  );
  const panelVisible = useDiffStore((s) => s.panelVisible);
  const showPanel = useDiffStore((s) => s.showPanel);
  const setActiveTab = useDiffStore((s) => s.setActiveTab);

  if (!hasTasks) return null;

  const handleClick = () => {
    showPanel();
    setActiveTab("tasks");
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            onClick={handleClick}
            className={cn(
              "gap-1.5 transition-colors",
              panelVisible
                ? "text-primary hover:bg-muted/40"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
            aria-label="Toggle tasks"
            aria-pressed={panelVisible}
          >
            <ListTodo size={14} />
            <span className="text-sm">Tasks</span>
          </Button>
        }
      />
      <TooltipContent>Toggle task panel (Ctrl+T)</TooltipContent>
    </Tooltip>
  );
}

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
  const [modelId, setModelId] = useState(getDefaultModelId());
  const [reasoning, setReasoning] = useState<ReasoningLevel>(getDefaultReasoningLevel());
  const [mode, setMode] = useState<InteractionMode>(INTERACTION_MODES.CHAT);
  const [access, setAccess] = useState<AccessMode>(PERMISSION_MODES.FULL);
  const [showReasoningPicker, setShowReasoningPicker] = useState(false);
  const [composerMode, setComposerModeLocal] = useState<ComposerMode>("direct");
  const [preparingWorktree, setPreparingWorktree] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [detectedPr, setDetectedPr] = useState<PrDetail | null>(null);
  const [prDismissed, setPrDismissed] = useState(false);
  const prDetectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editorRef = useRef<LexicalEditor | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  const prevThreadIdRef = useRef<string | undefined>(threadId);
  const draftRef = useRef({ input, attachments, modelId, reasoning });
  /** Tracks whether the user toggled mode/access before settings finished loading. */
  const agentSettingsTouchedRef = useRef(false);
  /** Set to true by the thread-switch effect; cleared by the model-sync effect.
   *  Prevents Effect 2 from overwriting Effect 1's model choice on thread switch. */
  const threadSwitchRef = useRef(false);

  // Keep draft ref in sync so the thread-switch effect reads current values
  useEffect(() => {
    draftRef.current = { input, attachments, modelId, reasoning };
  });

  const saveDraft = useComposerDraftStore((s) => s.saveDraft);
  const getDraft = useComposerDraftStore((s) => s.getDraft);
  const clearDraftFromStore = useComposerDraftStore((s) => s.clearDraft);
  const pendingPrefill = useComposerDraftStore((s) => s.pendingPrefill);
  const clearPendingPrefill = useComposerDraftStore((s) => s.clearPendingPrefill);

  // Reactive settings: sync model/reasoning defaults when settings finish loading
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const settingsDefaultModelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const settingsDefaultReasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const settingsDefaultMode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const settingsDefaultPermission = useSettingsStore((s) => s.settings.agent.defaults.permission);

  useEffect(() => {
    if (!settingsLoaded) return;
    // Only sync global defaults for new threads.
    // Existing threads restore settings from the thread record in the thread-switch effect.
    if (threadId) return;

    const validModelId = findModelById(settingsDefaultModelId) ? settingsDefaultModelId : "claude-sonnet-4-6";
    setModelId(validModelId);
    setReasoning(normalizeReasoningLevelForModel(validModelId, settingsDefaultReasoning));

    if (!agentSettingsTouchedRef.current) {
      setMode(settingsDefaultMode === "plan" ? INTERACTION_MODES.PLAN : INTERACTION_MODES.CHAT);
      setAccess(settingsDefaultPermission);
    }
  }, [settingsLoaded, settingsDefaultModelId, settingsDefaultReasoning, settingsDefaultMode, settingsDefaultPermission, threadId]);

  // Reset reasoning when the selected model does not support the current level
  useEffect(() => {
    const normalized = normalizeReasoningLevelForModel(modelId, reasoning);
    if (normalized !== reasoning) {
      setReasoning(normalized);
    }
  }, [modelId, reasoning]);

  // Save draft for previous thread, restore draft for new thread
  useEffect(() => {
    const prev = prevThreadIdRef.current;

    // Save current draft for the thread we're leaving (but not if the thread was deleted)
    if (prev && prev !== threadId) {
      const threadStillExists = useWorkspaceStore.getState().threads.some((t) => t.id === prev);
      if (threadStillExists) {
        saveDraft(prev, draftRef.current);
      } else {
        // Thread was deleted; revoke any attachment blob URLs from the outgoing draft
        for (const att of draftRef.current.attachments) {
          if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
        }
      }
    }

    // Restore draft for the thread we're entering
    if (threadId) {
      const saved = getDraft(threadId);
      if (saved) {
        setInput(saved.input);
        setAttachments(saved.attachments);
        setModelId(saved.modelId);
        setReasoning(normalizeReasoningLevelForModel(saved.modelId, saved.reasoning));
        // Restore Lexical editor content
        if (editorRef.current) {
          const editor = editorRef.current;
          editor.update(() => {
            const root = $getRoot();
            root.clear();
            if (saved.input) {
              const para = $createParagraphNode();
              para.append($createTextNode(saved.input));
              root.append(para);
            } else {
              root.append($createParagraphNode());
            }
          });
        }
      } else {
        // No saved draft: use thread's persisted settings as-is
        setInput("");
        setAttachments([]);
        const nextThread = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
        const resolvedModelId = resolveThreadModelId(nextThread?.model, getDefaultModelId());
        setModelId(resolvedModelId);
        setReasoning(normalizeReasoningLevelForModel(
          resolvedModelId,
          nextThread?.reasoning_level
            ? (nextThread.reasoning_level as ReasoningLevel)
            : getDefaultReasoningLevel(),
        ));

        // Restore mode and permission from thread record
        const { settings: globalSettings } = useSettingsStore.getState();
        setMode(
          nextThread?.interaction_mode === "plan"
            ? INTERACTION_MODES.PLAN
            : nextThread?.interaction_mode === "chat"
              ? INTERACTION_MODES.CHAT
              : globalSettings.agent.defaults.mode === "plan"
                ? INTERACTION_MODES.PLAN
                : INTERACTION_MODES.CHAT,
        );
        setAccess(
          nextThread?.permission_mode
            ? (nextThread.permission_mode as PermissionMode)
            : globalSettings.agent.defaults.permission,
        );

        // Reset Lexical editor
        if (editorRef.current) {
          editorRef.current.update(() => {
            const root = $getRoot();
            root.clear();
            root.append($createParagraphNode());
          });
        }
      }
    } else {
      // Entering "new thread" mode: ensure clean slate
      setInput("");
      setAttachments([]);
      setModelId(getDefaultModelId());
      setReasoning(normalizeReasoningLevelForModel(getDefaultModelId(), getDefaultReasoningLevel()));
      // Reset mode/access to persisted defaults
      agentSettingsTouchedRef.current = false;
      const { settings } = useSettingsStore.getState();
      setMode(settings.agent.defaults.mode === "plan" ? INTERACTION_MODES.PLAN : INTERACTION_MODES.CHAT);
      setAccess(settings.agent.defaults.permission);
      if (editorRef.current) {
        editorRef.current.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
      }
    }

    threadSwitchRef.current = true;
    prevThreadIdRef.current = threadId;
  }, [threadId, saveDraft, getDraft]);

  // Consume pending prefill set by empty-state prompt chips
  useEffect(() => {
    if (!pendingPrefill) return;
    setInput(pendingPrefill);
    if (editorRef.current) {
      editorRef.current.update(() => {
        const root = $getRoot();
        root.clear();
        const para = $createParagraphNode();
        para.append($createTextNode(pendingPrefill));
        root.append(para);
      });
      clearPendingPrefill();
      editorRef.current.focus();
    }
  }, [pendingPrefill, clearPendingPrefill]);

  const fileAutocomplete = useFileAutocomplete({
    workspaceId,
    threadId,
  });

  const handleFileSelect = useCallback((filePath: string) => {
    fileAutocomplete.selectFile(filePath);
    if (editorRef.current) {
      insertMentionNode(
        editorRef.current,
        filePath,
        fileAutocomplete.triggerStart,
        fileAutocomplete.query.length,
      );
    }
  }, [fileAutocomplete]);

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
  const setThreadSettings = useThreadStore((s) => s.setThreadSettings);
  const contextEntry = useThreadStore((s) => threadId ? s.contextByThread[threadId] : undefined);
  const isCompacting = useThreadStore((s) => !!(threadId && s.isCompactingByThread[threadId]));
  const planPending = useThreadStore(
    (s) => !!threadId && (s.planQuestionsStatusByThread[threadId] ?? "idle") === "pending",
  );
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
    anchorRef: editorContainerRef,
    cwd: workspacePath,
    onMcodeCommand: (action) => {
      if (action === "toggle-plan") {
        const next =
          mode === INTERACTION_MODES.PLAN
            ? INTERACTION_MODES.CHAT
            : INTERACTION_MODES.PLAN;
        setMode(next);
        if (threadId) void setThreadSettings(threadId, { interactionMode: next });
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
  const openPrs = useWorkspaceStore((s) => s.openPrs);
  const openPrsLoading = useWorkspaceStore((s) => s.openPrsLoading);
  const fetchingBranch = useWorkspaceStore((s) => s.fetchingBranch);
  const loadOpenPrs = useWorkspaceStore((s) => s.loadOpenPrs);
  const fetchBranch = useWorkspaceStore((s) => s.fetchBranch);

  // Sync modelId if thread.model changes server-side (e.g. user changed model from another client).
  // This does NOT fire on SDK model fallback because fallback no longer mutates thread.model --
  // fallback is stored transiently in lastFallbackByThread. The model picker intentionally
  // stays at the user's intended model; the fallback toast notifies them of the actual model used.
  useEffect(() => {
    if (!activeThread?.model) return;
    if (threadSwitchRef.current) {
      threadSwitchRef.current = false;
      return;
    }
    const hasDraft = threadId ? getDraft(threadId) != null : false;
    const isRunning = threadId ? useThreadStore.getState().runningThreadIds.has(threadId) : false;
    if (hasDraft && !isRunning) return;
    setModelId(activeThread.model);
  }, [activeThread?.model, threadId, getDraft]);

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

  // Load branches when entering new thread mode (always refresh to pick up live changes)
  useEffect(() => {
    if (isNewThread && workspaceId) {
      loadBranches(workspaceId);
    }
  }, [isNewThread, workspaceId, loadBranches]);

  // Auto-select current branch if none selected
  useEffect(() => {
    if (isNewThread && !newThreadBranch && branches.length > 0) {
      const current = branches.find((b) => b.isCurrent);
      if (current) setNewThreadBranch(current.name);
    }
  }, [isNewThread, newThreadBranch, branches, setNewThreadBranch]);

  // Load open PRs when in worktree mode
  useEffect(() => {
    if (isNewThread && workspaceId && composerMode === "worktree") {
      loadOpenPrs(workspaceId);
    }
  }, [isNewThread, workspaceId, composerMode, loadOpenPrs]);

  // Detect GitHub PR URLs pasted into the input (debounced 500ms)
  useEffect(() => {
    if (prDetectTimeoutRef.current) {
      clearTimeout(prDetectTimeoutRef.current);
    }

    if (prDismissed || !isNewThread) {
      return;
    }

    const match = input.match(/https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    if (!match) {
      setDetectedPr(null);
      return;
    }

    const url = match[0];
    prDetectTimeoutRef.current = setTimeout(async () => {
      try {
        const pr = await getTransport().getPrByUrl(url);
        setDetectedPr(pr);
      } catch {
        setDetectedPr(null);
      }
    }, 500);

    return () => {
      if (prDetectTimeoutRef.current) {
        clearTimeout(prDetectTimeoutRef.current);
      }
    };
  }, [input, prDismissed, isNewThread]);

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

  const handleFetchAndSelect = useCallback(async (branch: string, prNumber: number) => {
    if (!workspaceId) return;
    await fetchBranch(workspaceId, branch, prNumber);
    setNewThreadBranch(branch);
    // Use the PR branch name directly as the worktree branch
    setNamingMode("custom");
    setCustomBranchName(branch);
  }, [workspaceId, fetchBranch, setNewThreadBranch, setNamingMode, setCustomBranchName]);

  const handlePrReview = useCallback(async () => {
    if (!detectedPr || !workspaceId) return;
    setComposerMode("worktree");
    await fetchBranch(workspaceId, detectedPr.branch, detectedPr.number);
    setNewThreadBranch(detectedPr.branch);
    // Use the PR branch name directly as the worktree branch
    setNamingMode("custom");
    setCustomBranchName(detectedPr.branch);
    const prefill = `Review PR #${detectedPr.number}: ${detectedPr.title}`;
    setInput(prefill);
    // Also populate the Lexical editor so the user sees the prefilled text
    editorRef.current?.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode(prefill));
      root.append(para);
    });
    setDetectedPr(null);
    setPrDismissed(false);
  }, [detectedPr, workspaceId, setComposerMode, fetchBranch, setNewThreadBranch, setNamingMode, setCustomBranchName]);

  const addFiles = useCallback((files: File[], filePaths?: (string | null)[]) => {
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length;
      if (remaining <= 0) return prev;

      const newAttachments: PendingAttachment[] = [];
      for (let i = 0; i < Math.min(files.length, remaining); i++) {
        const file = files[i];
        if (!isFileSupported(file.name)) continue;
        if (file.size > getMaxFileSize(file.name)) continue;

        const mimeType = file.type || inferMimeType(file.name);
        const previewUrl = classifyFile(file.name) === "image"
          ? URL.createObjectURL(file)
          : "";

        newAttachments.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType,
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
    const supported = files.filter((f) => isFileSupported(f.name));
    if (supported.length === 0) return;

    e.preventDefault();

    const bridge = window.desktopBridge;

    // Attempt to resolve real file paths for all supported files
    const paths = supported.map((f) => {
      try { return bridge?.getPathForFile?.(f) || null; } catch { return null; }
    });

    // Partition into files with and without real paths
    const withPaths: File[] = [];
    const withPathPaths: (string | null)[] = [];
    const withoutPaths: File[] = [];

    for (let i = 0; i < supported.length; i++) {
      if (paths[i]) {
        withPaths.push(supported[i]);
        withPathPaths.push(paths[i]);
      } else {
        withoutPaths.push(supported[i]);
      }
    }

    // Files with real paths go straight to addFiles
    if (withPaths.length > 0) {
      addFiles(withPaths, withPathPaths);
    }

    // Files without paths need fallback handling
    for (const file of withoutPaths) {
      if (classifyFile(file.name) === "image") {
        // Images: use existing clipboard image reader
        try {
          const meta = bridge?.readClipboardImage
            ? await bridge.readClipboardImage()
            : await getTransport().readClipboardImage();
          if (meta) {
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              const previewUrl = URL.createObjectURL(file);
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
          addFiles([file]);
        }
      } else {
        // Non-images (PDF, text): read blob and save via bridge or transport
        if (file.size > getMaxFileSize(file.name)) continue;
        const mimeType = file.type || inferMimeType(file.name);
        try {
          let meta: AttachmentMeta | null = null;
          if (bridge?.saveClipboardFile) {
            const arrayBuffer = await file.arrayBuffer();
            meta = await bridge.saveClipboardFile(
              new Uint8Array(arrayBuffer),
              mimeType,
              file.name,
            );
          } else {
            // Send binary data directly over WebSocket (no base64 encoding)
            const arrayBuffer = await file.arrayBuffer();
            meta = await getTransport().saveClipboardFile(arrayBuffer, mimeType, file.name);
          }
          if (meta) {
            const resolved = meta;
            setAttachments((prev) => {
              if (prev.length >= MAX_ATTACHMENTS) return prev;
              return [...prev, {
                id: resolved.id,
                name: resolved.name,
                mimeType: resolved.mimeType,
                sizeBytes: resolved.sizeBytes,
                previewUrl: "",
                filePath: resolved.sourcePath,
              }];
            });
          }
        } catch {
          addFiles([file]);
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
    const supported = files.filter((f) => isFileSupported(f.name));
    if (supported.length === 0) return;
    const bridge = window.desktopBridge;
    const paths = supported.map((f) => {
      try { return bridge?.getPathForFile?.(f) ?? null; } catch { return null; }
    });
    addFiles(supported, paths);
    editorRef.current?.focus();
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
    // Prevent double-submission via keyboard while a worktree is being created.
    // The button is already disabled via `preparingWorktree`, but the keyboard
    // Enter handler bypasses that. Without this guard, a second Enter press can
    // trigger a duplicate createAndSendMessage call before the first RPC returns.
    if (preparingWorktree) return;
    const trimmed = input.trim();

    // ---- Queue path: agent is running on this thread ----
    if (isAgentRunning && threadId) {
      const { content, display } = await injectFileContent(trimmed);
      const currentAttachments = collectAndClearAttachments();

      const queueProvider = findProviderForModel(modelId)?.id;
      useQueueStore.getState().enqueue(threadId, {
        content,
        displayContent: display,
        attachments: currentAttachments,
        model: modelId,
        permissionMode: access,
        reasoningLevel: reasoning,
        provider: queueProvider,
      });

      setInput("");
      if (threadId) clearDraftFromStore(threadId);
      if (editorRef.current) {
        editorRef.current.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
      }
      editorRef.current?.focus();
      return;
    }

    // ---- Normal send path ----
    const { content: messageContent, display: displayContent } = await injectFileContent(trimmed);
    const provider = findProviderForModel(modelId)?.id;

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
    if (editorRef.current) {
      editorRef.current.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      });
    }
    setDetectedPr(null);
    setPrDismissed(false);
    const currentAttachments = collectAndClearAttachments();
    if (threadId) clearDraftFromStore(threadId);

    if (isNewThread && workspaceId) {
      if (newThreadMode === "worktree" || newThreadMode === "existing-worktree") {
        setPreparingWorktree(true);
      }
      try {
        const newThread = await useWorkspaceStore.getState().createAndSendMessage(messageContent, modelId, access, currentAttachments.length > 0 ? currentAttachments : undefined, reasoning, provider, mode);
        // Persist settings to the newly created thread so they survive page reload
        if (newThread?.id) {
          void setThreadSettings(newThread.id, {
            interactionMode: mode,
            permissionMode: access,
            reasoningLevel: reasoning,
          });
        }
      } finally {
        setPreparingWorktree(false);
      }
    } else if (threadId) {
      await sendMessage(threadId, messageContent, modelId, access, currentAttachments.length > 0 ? currentAttachments : undefined, displayContent, reasoning, provider);
      // Persist per-thread settings so they survive page reload
      void setThreadSettings(threadId, {
        interactionMode: mode,
        permissionMode: access,
        reasoningLevel: reasoning,
      });
    }

    // Auto-save last-used mode and access as defaults (model defaults are managed in Settings)
    const { settings, loaded, update: updateSettings } = useSettingsStore.getState();
    if (loaded && (mode !== settings.agent.defaults.mode || access !== settings.agent.defaults.permission)) {
      void updateSettings({
        agent: {
          defaults: {
            mode,
            permission: access,
          },
        },
      });
    }

    editorRef.current?.focus();
  }, [input, attachments, isAgentRunning, isNewThread, newThreadMode, newThreadBranch, workspaceId, threadId, sendMessage, modelId, reasoning, mode, access, namingMode, customBranchName, selectedWorktree, injectFileContent, collectAndClearAttachments, clearDraftFromStore, preparingWorktree]);

  const handleEditorChange = useCallback((text: string) => {
    setInput(text);
  }, []);

  const handleSlashSelect = useCallback((cmd: Command) => {
    // No-op replaceText: Lexical handles text replacement via insertSlashCommandNode
    slashCommand.onSelect(cmd, () => {});
    // Action-only commands (e.g. /plan toggle) should not insert a chip
    if (!cmd.action && editorRef.current) {
      insertSlashCommandNode(editorRef.current, cmd.name, cmd.namespace);
    }
  }, [slashCommand]);

  // Unified popup keyboard handler for Lexical's KeyboardPlugin.
  // Delegates to the file tag popup or slash command popup depending on which is open.
  const isAnyPopupOpen = fileAutocomplete.isOpen || slashCommand.isOpen;

  const handlePopupKeyDown = useCallback((key: string): boolean => {
    if (fileAutocomplete.isOpen) {
      // Synthesize a minimal React.KeyboardEvent for the file popup handler
      const fakeEvent = {
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.KeyboardEvent;
      return filePopup.handleKeyDown(fakeEvent);
    }
    if (slashCommand.isOpen) {
      if (key === "Enter" || key === "Tab") {
        const cmd = slashCommand.items[slashCommand.selectedIndex];
        if (cmd) {
          handleSlashSelect(cmd);
          return true;
        }
      }
      if (key === "Escape") {
        slashCommand.onDismiss();
        return true;
      }
      const fakeEvent = {
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.KeyboardEvent;
      slashCommand.onKeyDown(fakeEvent);
      return key === "ArrowDown" || key === "ArrowUp";
    }
    return false;
  }, [fileAutocomplete.isOpen, filePopup, slashCommand, handleSlashSelect]);

  const toast = useQueueStore((s) => s.toast);

  /** Display label for a reasoning level value. */
  const reasoningLabel = (level: string) =>
    level === "xhigh" ? "X-High" : level.charAt(0).toUpperCase() + level.slice(1);

  const codexLevels = getCodexReasoningLevels(modelId);
  const reasoningLevels: ReasoningLevel[] = codexLevels
    ? (codexLevels as unknown as ReasoningLevel[])
    : isMaxEffortModel(modelId)
      ? ["low", "medium", "high", "max"]
      : ["low", "medium", "high"];

  return (
    <div className="relative px-8 py-4">
      {/* Gradient fade replacing the hard border-t line */}
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-background to-transparent" />
      {/* Queue toast */}
      {toast && (
        <div className="pointer-events-none absolute -top-8 right-4 z-20 flex items-center gap-1.5 rounded-full bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
          <Check size={10} className="text-primary" />
          {toast}
        </div>
      )}

      {/* Max-width wrapper to align with message list column */}
      <div className="mx-auto w-full max-w-4xl">

      {/* Main composer container - dark bg, rounded */}
      <div
        className={cn(
          "relative rounded-xl bg-muted/50 ring-1 ring-border/60 shadow-lg shadow-black/20 focus-within:ring-2 focus-within:ring-primary/70",
          isDragOver && "ring-2 ring-primary"
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* PR URL detection card */}
        {detectedPr && !prDismissed && (
          <PrDetectedCard
            number={detectedPr.number}
            title={detectedPr.title}
            branch={detectedPr.branch}
            author={detectedPr.author}
            onReview={handlePrReview}
            onDismiss={() => {
              setDetectedPr(null);
              setPrDismissed(true);
            }}
            loading={!!fetchingBranch}
          />
        )}

        {/* Lexical editor with file tag popup */}
        <div className="relative" ref={editorContainerRef} onPaste={handlePaste}>
          <ComposerEditor
            onChange={handleEditorChange}
            onSubmit={handleSend}
            onMentionTrigger={fileAutocomplete.handleInputChange}
            onMentionDismiss={fileAutocomplete.dismiss}
            isMentionPopupOpen={fileAutocomplete.isOpen}
            onSlashTrigger={slashCommand.onInputChange}
            onSlashDismiss={slashCommand.onDismiss}
            isSlashPopupOpen={slashCommand.isOpen}
            editorRef={editorRef}
            disabled={planPending}
            isPopupOpen={isAnyPopupOpen}
            onPopupKeyDown={handlePopupKeyDown}
            placeholder={planPending ? "Answer the planning questions above" : isAgentRunning ? "Queue a follow-up..." : "Message Mcode..."}
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

        {/* Compacting banner — shown while the SDK is summarising the context window */}
        {isCompacting && <CompactingBanner />}

        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 backdrop-blur-sm">
            <span className="text-sm font-medium text-primary">Drop files here</span>
          </div>
        )}

        {/* Controls row - inside the container */}
        <div className="flex items-center gap-2.5 border-t border-border/20 px-3 py-1.5">
          {/* Model picker */}
          <ModelSelector
            selectedModelId={modelId}
            onSelect={setModelId}
            locked={isModelFullyLocked}
            providerLocked={isProviderLocked}
          />

          {/* Reasoning level */}
          <div className="relative">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowReasoningPicker(!showReasoningPicker);
                    }}
                    className="gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                  >
                    <span className="text-sm">{reasoningLabel(reasoning)}</span>
                    <ChevronDown size={11} />
                  </Button>
                }
              />
              <TooltipContent>Reasoning level</TooltipContent>
            </Tooltip>
            {showReasoningPicker && (
              <div className="absolute bottom-full left-0 z-20 mb-1 rounded-md border border-border bg-card p-1 shadow-lg">
                {reasoningLevels.map((level) => (
                  <button
                    key={level}
                    onClick={(e) => {
                      e.stopPropagation();
                      setReasoning(level);
                      if (threadId) void setThreadSettings(threadId, { reasoningLevel: level });
                      setShowReasoningPicker(false);
                    }}
                    className={cn(
                      "flex w-full items-center rounded px-3 py-1.5 text-xs",
                      reasoning === level
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                  >
                    {reasoningLabel(level)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Chat / Plan toggle */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const next = mode === INTERACTION_MODES.CHAT ? INTERACTION_MODES.PLAN : INTERACTION_MODES.CHAT;
                    setMode(next);
                    agentSettingsTouchedRef.current = true;
                    if (threadId) void setThreadSettings(threadId, { interactionMode: next });
                  }}
                  className="gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                >
                  {mode === INTERACTION_MODES.CHAT ? <MessageSquare size={14} /> : <FileEdit size={14} />}
                  <span className="text-sm">{mode === INTERACTION_MODES.CHAT ? "Chat" : "Plan"}</span>
                </Button>
              }
            />
            <TooltipContent>{mode === INTERACTION_MODES.CHAT ? "Chat mode" : "Plan mode"}</TooltipContent>
          </Tooltip>

          {/* Full access / Supervised toggle */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const next: AccessMode = access === PERMISSION_MODES.FULL ? PERMISSION_MODES.SUPERVISED : PERMISSION_MODES.FULL;
                    setAccess(next);
                    agentSettingsTouchedRef.current = true;
                    if (threadId) void setThreadSettings(threadId, { permissionMode: next });
                  }}
                  className="gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                >
                  {access === PERMISSION_MODES.FULL ? <Unlock size={14} /> : <Lock size={14} />}
                  <span className="text-sm">{access === PERMISSION_MODES.FULL ? "Full access" : "Supervised"}</span>
                </Button>
              }
            />
            <TooltipContent>{access === PERMISSION_MODES.FULL ? "Full access mode" : "Supervised mode"}</TooltipContent>
          </Tooltip>

          {/* Tasks toggle - only visible when thread has tasks */}
          <TasksToggle threadId={threadId} />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Preparing worktree indicator */}
          {preparingWorktree && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Preparing worktree...
            </span>
          )}

          {/* Inline stop button: visible when agent running AND user has input AND wizard not pending */}
          {isAgentRunning && hasContent && !planPending && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleStop}
              className="text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
              title="Stop agent"
              aria-label="Stop agent"
            >
              <div className="h-2.5 w-2.5 rounded-sm bg-current" />
            </Button>
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
                    next.attachments.length > 0 ? next.attachments : undefined, next.displayContent, next.reasoningLevel, next.provider);
                }
              }}
            />
          )}

          {/* Context window tracker — live data from turnComplete, fallback to persisted thread record */}
          {threadId && (
            <ContextTracker
              tokensIn={contextEntry?.lastTokensIn ?? activeThread?.last_context_tokens ?? 0}
              contextWindow={contextEntry?.contextWindow ?? activeThread?.context_window ?? DEFAULT_CONTEXT_WINDOW}
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
              planPending ||
              preparingWorktree ||
              (!isAgentRunning && !hasContent)
            }
            className={cn(
              "rounded-full p-1.5 transition-colors",
              preparingWorktree
                ? "bg-primary text-primary-foreground animate-spin"
                : isAgentRunning && hasContent
                  ? "bg-primary/60 text-primary-foreground hover:bg-primary/75"
                  : isAgentRunning
                    ? "bg-destructive text-white hover:bg-destructive/90"
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
            aria-label={
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
              <div className="h-3 w-3 rounded-sm bg-current" />
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
        <AgentStatusBar />
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
                  pullRequests={openPrs}
                  prsLoading={openPrsLoading}
                  fetchingBranch={fetchingBranch}
                  onFetchAndSelect={handleFetchAndSelect}
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
      </div>{/* end max-width wrapper */}

      <SlashCommandPopup
        isOpen={slashCommand.isOpen}
        isLoading={slashCommand.isLoading}
        items={slashCommand.items}
        selectedIndex={slashCommand.selectedIndex}
        anchorRect={slashCommand.anchorRect}
        onSelect={handleSlashSelect}
        onDismiss={slashCommand.onDismiss}
      />
    </div>
  );
}
