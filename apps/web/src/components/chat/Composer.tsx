import { useState, useRef, useCallback, useEffect } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  ArrowUp,
  MessageSquare,
  FileEdit,
  Lock,
  Unlock,
  ChevronDown,
  Sparkles,
  FolderOpen,
  GitBranch,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ComposerProps {
  threadId: string;
}

type InteractionMode = "chat" | "plan";
type AccessMode = "full" | "supervised";
type ReasoningLevel = "low" | "medium" | "high";
type ModelId = "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-haiku-4-5";

const CLAUDE_MODELS: readonly { id: ModelId; label: string }[] = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export function Composer({ threadId }: ComposerProps) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<ModelId>("claude-sonnet-4-6");
  const [reasoning, setReasoning] = useState<ReasoningLevel>("high");
  const [mode, setMode] = useState<InteractionMode>("chat");
  const [access, setAccess] = useState<AccessMode>("full");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showReasoningPicker, setShowReasoningPicker] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useThreadStore((s) => s.sendMessage);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const isAgentRunning = runningThreadIds.has(threadId);

  const threads = useWorkspaceStore((s) => s.threads);
  const activeThread = threads.find((t) => t.id === threadId);

  const currentModel = CLAUDE_MODELS.find((m) => m.id === model) ?? CLAUDE_MODELS[1];

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = () => {
      setShowModelPicker(false);
      setShowReasoningPicker(false);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isAgentRunning) return;

    setInput("");
    await sendMessage(threadId, trimmed);
    textareaRef.current?.focus();
  }, [input, isAgentRunning, threadId, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  return (
    <div className="border-t border-border">
      {/* Textarea */}
      <div className="px-4 pt-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask for follow-up changes or attach images"
          rows={2}
          className="w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          disabled={isAgentRunning}
        />
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-1 px-3 py-1.5">
        {/* Model picker */}
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowModelPicker(!showModelPicker);
              setShowReasoningPicker(false);
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Sparkles size={12} className="text-orange-400" />
            {currentModel.label.replace("Claude ", "")}
            <ChevronDown size={10} />
          </button>
          {showModelPicker && (
            <div className="absolute bottom-full left-0 mb-1 rounded-md border border-border bg-card p-1 shadow-lg">
              {CLAUDE_MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setModel(m.id);
                    setShowModelPicker(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                    model === m.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <Sparkles size={11} className="text-orange-400" />
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="text-border">|</span>

        {/* Reasoning level */}
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowReasoningPicker(!showReasoningPicker);
              setShowModelPicker(false);
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
          onClick={() => setMode(mode === "chat" ? "plan" : "chat")}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {mode === "chat" ? (
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
          onClick={() => setAccess(access === "full" ? "supervised" : "full")}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {access === "full" ? (
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

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!input.trim() || isAgentRunning}
          className={cn(
            "rounded-full p-1.5 transition-colors",
            input.trim() && !isAgentRunning
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground opacity-40"
          )}
        >
          <ArrowUp size={14} />
        </button>
      </div>

      {/* Status bar: Local/Worktree + Branch */}
      <div className="flex items-center justify-between border-t border-border/50 px-3 py-1">
        <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
          <FolderOpen size={11} />
          {activeThread?.mode === "worktree" ? "Worktree" : "Local"}
          <ChevronDown size={9} />
        </button>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <GitBranch size={11} />
          {activeThread?.branch ?? "main"}
        </span>
      </div>
    </div>
  );
}
