import { useState, useRef, useCallback, useEffect } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { PermissionMode, InteractionMode } from "@/transport";
import { PERMISSION_MODES, INTERACTION_MODES } from "@/transport";
import {
  ArrowUp,
  Square,
  MessageSquare,
  FileEdit,
  Lock,
  Unlock,
  ChevronDown,
  Loader2,
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

interface ComposerProps {
  threadId?: string;
  isNewThread?: boolean;
  workspaceId?: string;
}

type AccessMode = PermissionMode;
type ReasoningLevel = "low" | "medium" | "high";

export function Composer({ threadId, isNewThread, workspaceId }: ComposerProps) {
  const [input, setInput] = useState("");
  const [modelId, setModelId] = useState(getDefaultModel().id);
  const [reasoning, setReasoning] = useState<ReasoningLevel>("high");
  const [mode, setMode] = useState<InteractionMode>(INTERACTION_MODES.CHAT);
  const [access, setAccess] = useState<AccessMode>(PERMISSION_MODES.FULL);
  const [showReasoningPicker, setShowReasoningPicker] = useState(false);
  const [composerMode, setComposerModeLocal] = useState<ComposerMode>("direct");
  const [preparingWorktree, setPreparingWorktree] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useThreadStore((s) => s.sendMessage);
  const stopAgent = useThreadStore((s) => s.stopAgent);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const getThreadSettings = useThreadStore((s) => s.getThreadSettings);
  const setThreadSettings = useThreadStore((s) => s.setThreadSettings);
  const isAgentRunning = threadId ? runningThreadIds.has(threadId) : false;

  const threads = useWorkspaceStore((s) => s.threads);
  const activeThread = threadId ? threads.find((t) => t.id === threadId) : undefined;

  const branches = useWorkspaceStore((s) => s.branches);
  const branchesLoading = useWorkspaceStore((s) => s.branchesLoading);
  const newThreadMode = useWorkspaceStore((s) => s.newThreadMode);
  const newThreadBranch = useWorkspaceStore((s) => s.newThreadBranch);
  const loadBranches = useWorkspaceStore((s) => s.loadBranches);
  const setNewThreadMode = useWorkspaceStore((s) => s.setNewThreadMode);
  const setNewThreadBranch = useWorkspaceStore((s) => s.setNewThreadBranch);

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

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isAgentRunning) return;

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
      }
    }

    setInput("");
    if (isNewThread && workspaceId) {
      if (newThreadMode === "worktree" || newThreadMode === "existing-worktree") {
        setPreparingWorktree(true);
      }
      try {
        await useWorkspaceStore.getState().createAndSendMessage(trimmed, modelId, access);
      } finally {
        setPreparingWorktree(false);
      }
    } else if (threadId) {
      await sendMessage(threadId, trimmed, modelId, access);
    }
    textareaRef.current?.focus();
  }, [input, isAgentRunning, isNewThread, newThreadMode, newThreadBranch, workspaceId, threadId, sendMessage, modelId, access, namingMode, customBranchName, selectedWorktree]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isAgentRunning) return;
      handleSend();
    }
    // Shift+Enter allows natural newline
  };

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  return (
    <div className="border-t border-border px-4 py-3">
      {/* Main composer container - dark bg, rounded */}
      <div className="rounded-xl bg-muted/50 ring-1 ring-border focus-within:ring-primary/50">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask for follow-up changes or attach images"
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          disabled={isAgentRunning}
        />

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

          {/* Send / Stop toggle */}
          <button
            onClick={isAgentRunning ? handleStop : handleSend}
            disabled={preparingWorktree || (!isAgentRunning && !input.trim())}
            className={cn(
              "rounded-full p-2 transition-colors",
              preparingWorktree
                ? "bg-primary text-primary-foreground animate-spin"
                : isAgentRunning
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : input.trim()
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-muted text-muted-foreground opacity-40"
            )}
          >
            {preparingWorktree ? <Loader2 size={14} /> : isAgentRunning ? <Square size={14} /> : <ArrowUp size={14} />}
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
    </div>
  );
}
