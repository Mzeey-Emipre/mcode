import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, AlertCircle, Copy, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";
import { registerCommand } from "@/lib/command-registry";

interface SummaryRecord {
  readonly id: string;
  readonly threadId: string;
  readonly content: string;
  readonly turnCount: number;
  readonly lastTurnId: string | null;
  readonly model: string;
  readonly createdAt: string;
}

interface SummaryActions {
  readonly onCancel: () => void;
  readonly onCopy: () => Promise<void>;
  readonly onGenerate: () => Promise<void>;
}

/**
 * Format an ISO timestamp as a short relative time string (e.g. "2h ago").
 * Returns "just now" for timestamps within the last minute.
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff <= 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

/**
 * Format an ISO timestamp as a locale-appropriate absolute datetime string.
 * Used as a hover tooltip on the relative time display.
 */
function absoluteTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Summary tab content for the diff panel.
 *
 * Four visual states:
 * - Empty: prompt to generate a summary with a CTA button
 * - Loading (initial): three-dot pulse while first summary generates
 * - Regenerating: old summary stays visible with a loading overlay
 * - Rendered: markdown content with metadata and a regenerate button
 */
export function SummaryView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  // Only count snapshots that actually have file changes
  const hasFileChanges = snapshots?.some((s) => s.files_changed.length > 0) ?? false;

  const summaryRecord = useDiffStore((s) => s.summaryRecord);
  const summaryLoading = useDiffStore((s) => s.summaryLoading);
  const setSummaryRecord = useDiffStore((s) => s.setSummaryRecord);
  const setSummaryLoading = useDiffStore((s) => s.setSummaryLoading);

  const [errorForThread, setErrorForThread] = useState<{ threadId: string | null; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute staleness: count turns with file changes that arrived after the summary's lastTurnId
  const newTurnCount = (() => {
    if (!summaryRecord || !snapshots || !summaryRecord.lastTurnId) return 0;
    const lastIdx = snapshots.findIndex(
      (s) => s.message_id === summaryRecord.lastTurnId,
    );
    if (lastIdx === -1) return 0;
    return snapshots
      .slice(lastIdx + 1)
      .filter((s) => s.files_changed.length > 0).length;
  })();

  const error = errorForThread?.threadId === activeThreadId ? errorForThread.message : null;

  // Load persisted summary on mount or when the thread changes
  useEffect(() => {
    if (!activeThreadId) return;
    if (summaryRecord?.threadId === activeThreadId) return;

    let cancelled = false;

    const load = async () => {
      try {
        const result = await getTransport().getDiffSummary(activeThreadId);
        if (!cancelled) setSummaryRecord(result);
      } catch (err) {
        if (cancelled) return;
        setSummaryRecord(null);
        setErrorForThread({
          threadId: activeThreadId,
          message: err instanceof Error ? err.message : "Failed to load summary",
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, summaryRecord?.threadId, setSummaryRecord]);

  const handleGenerate = useCallback(async () => {
    if (!activeThreadId) return;
    const requestThreadId = activeThreadId;
    setErrorForThread(null);
    setSummaryLoading(true);

    // Cancel any in-flight request (client-side only — the server will
    // still complete the LLM call; the abort just suppresses stale state updates)
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await getTransport().generateDiffSummary(requestThreadId);
      if (controller.signal.aborted) return;
      // Ignore stale responses if the user switched threads during generation
      if (useWorkspaceStore.getState().activeThreadId !== requestThreadId) return;
      setSummaryRecord(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (useWorkspaceStore.getState().activeThreadId !== requestThreadId) return;
      const message = err instanceof Error ? err.message : "Failed to generate summary";
      setErrorForThread({ threadId: requestThreadId, message });
    } finally {
      if (!controller.signal.aborted) {
        setSummaryLoading(false);
      }
    }
  }, [activeThreadId, setSummaryLoading, setSummaryRecord]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSummaryLoading(false);
  }, [setSummaryLoading]);

  const handleCopy = useCallback(async () => {
    if (!summaryRecord?.content) return;
    try {
      await navigator.clipboard.writeText(summaryRecord.content);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable
    }
  }, [summaryRecord?.content]);

  // Cleanup abort controller and timers on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Keep a stable ref to handleGenerate so the command handler stays current
  const generateRef = useRef(handleGenerate);
  generateRef.current = handleGenerate;

  // Register global keyboard command for summary generation (mod+shift+g)
  useEffect(() => {
    return registerCommand({
      id: "summary.generate",
      title: "Generate Summary",
      category: "Changes",
      handler: () => void generateRef.current(),
    });
  }, []);

  const summary = summaryRecord?.threadId === activeThreadId ? summaryRecord : null;
  const state = getSummaryViewState(summaryLoading, summary);
  return (
    <SummaryContent
      actions={{ onCancel: handleCancel, onCopy: handleCopy, onGenerate: handleGenerate }}
      activeThreadId={activeThreadId}
      copied={copied}
      error={error}
      hasFileChanges={hasFileChanges}
      newTurnCount={newTurnCount}
      state={state}
      summary={summary}
    />
  );
}

type SummaryViewState = "empty" | "loading" | "regenerating" | "rendered";

function getSummaryViewState(
  loading: boolean,
  summary: SummaryRecord | null,
): SummaryViewState {
  if (!loading) return summary ? "rendered" : "empty";
  return summary ? "regenerating" : "loading";
}

function SummaryContent({
  actions,
  activeThreadId,
  copied,
  error,
  hasFileChanges,
  newTurnCount,
  state,
  summary,
}: {
  readonly actions: SummaryActions;
  readonly activeThreadId: string | null;
  readonly copied: boolean;
  readonly error: string | null;
  readonly hasFileChanges: boolean;
  readonly newTurnCount: number;
  readonly state: SummaryViewState;
  readonly summary: SummaryRecord | null;
}) {
  switch (state) {
    case "loading":
      return <InitialSummaryLoading onCancel={actions.onCancel} />;
    case "regenerating":
      return <RegeneratingSummary onCancel={actions.onCancel} summary={summary!} />;
    case "rendered":
      return (
        <RenderedSummary
          actions={actions}
          copied={copied}
          error={error}
          newTurnCount={newTurnCount}
          summary={summary!}
        />
      );
    case "empty":
      return (
        <EmptySummary
          activeThreadId={activeThreadId}
          error={error}
          hasFileChanges={hasFileChanges}
          onGenerate={actions.onGenerate}
        />
      );
  }
}

function SummaryDots() {
  return (
    <div className="flex items-center gap-1.5">
      {[0, 150, 300].map((delay) => (
        <div
          key={delay}
          className="h-1 w-1 rounded-full bg-muted-foreground/40 animate-pulse"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

function SummaryError({ error }: { readonly error: string | null }) {
  if (!error) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
      <AlertCircle size={12} aria-hidden="true" />
      <span>{error}</span>
    </div>
  );
}

function RegeneratingSummary({
  onCancel,
  summary,
}: {
  readonly onCancel: () => void;
  readonly summary: SummaryRecord;
}) {
  return (
    <div className="relative flex flex-col gap-3 p-4">
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/80">
        <div role="status" aria-live="polite" aria-busy="true">
          <SummaryDots />
        </div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground/40">
          Regenerating
        </span>
        <CancelSummaryButton onCancel={onCancel} />
      </div>
      <div className="prose prose-sm dark:prose-invert text-[13px] leading-relaxed opacity-40">
        <MarkdownContent content={summary.content} />
      </div>
      <div className="flex items-center justify-between border-t border-border/30 pt-3">
        <SummaryModel className="text-[11px] text-muted-foreground truncate max-w-[200px]" model={summary.model} />
        <SummaryTiming summary={summary} />
      </div>
    </div>
  );
}

function InitialSummaryLoading({ onCancel }: { readonly onCancel: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-14"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <SummaryDots />
      <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground/40">
        Summarizing
      </span>
      <CancelSummaryButton onCancel={onCancel} />
    </div>
  );
}

function CancelSummaryButton({ onCancel }: { readonly onCancel: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onCancel}
      className="gap-1 text-[11px] text-muted-foreground hover:text-foreground"
    >
      <X size={12} />
      Cancel
    </Button>
  );
}

function SummaryTiming({ summary }: { readonly summary: SummaryRecord }) {
  return (
    <span className="text-[11px] text-muted-foreground">
      <SummaryTimestamp createdAt={summary.createdAt} />
      {" · "}{summary.turnCount} {summary.turnCount === 1 ? "turn" : "turns"}
    </span>
  );
}

function SummaryModel({ className, model }: { readonly className: string; readonly model: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{model}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">{model}</TooltipContent>
    </Tooltip>
  );
}

function SummaryTimestamp({ createdAt }: { readonly createdAt: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{relativeTime(createdAt)}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">{absoluteTime(createdAt)}</TooltipContent>
    </Tooltip>
  );
}

function RenderedSummary({
  actions,
  copied,
  error,
  newTurnCount,
  summary,
}: {
  readonly actions: SummaryActions;
  readonly copied: boolean;
  readonly error: string | null;
  readonly newTurnCount: number;
  readonly summary: SummaryRecord;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <SummaryError error={error} />
      <NewTurnsNotice newTurnCount={newTurnCount} />
      <div className="prose prose-sm dark:prose-invert text-[13px] leading-relaxed">
        <MarkdownContent content={summary.content} />
      </div>
      <div className="flex items-center justify-between border-t border-border/30 pt-3">
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground min-w-0">
          <SummaryModel className="truncate max-w-[140px]" model={summary.model} />
          <span className="shrink-0">
            {" · "}
            <SummaryTimestamp createdAt={summary.createdAt} />
            {" · "}{summary.turnCount} {summary.turnCount === 1 ? "turn" : "turns"}
          </span>
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={actions.onCopy}
                  className="h-6 w-6 text-muted-foreground/50 hover:text-foreground/70"
                  aria-label="Copy summary to clipboard"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </Button>
              }
            />
            <TooltipContent side="top" className="text-xs">
              {copied ? "Copied" : "Copy summary"}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="xs"
            onClick={actions.onGenerate}
            className="gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <RefreshCw size={12} />
            Regenerate
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewTurnsNotice({ newTurnCount }: { readonly newTurnCount: number }) {
  if (newTurnCount === 0) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border/30 pb-2">
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
      <span className="font-mono text-[10.5px] text-muted-foreground/60">
        {newTurnCount} new {newTurnCount === 1 ? "turn" : "turns"} since summary
      </span>
    </div>
  );
}

function EmptySummary({
  activeThreadId,
  error,
  hasFileChanges,
  onGenerate,
}: {
  readonly activeThreadId: string | null;
  readonly error: string | null;
  readonly hasFileChanges: boolean;
  readonly onGenerate: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14">
      <span aria-hidden="true" className="font-mono text-2xl leading-none text-muted-foreground/20">Σ</span>
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
        no summary
      </p>
      <SummaryError error={error} />
      <Button
        variant="ghost"
        size="xs"
        onClick={onGenerate}
        disabled={!hasFileChanges || !activeThreadId}
        className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
        aria-describedby={!hasFileChanges ? "generate-hint" : undefined}
      >
        {error ? "Try again" : "Generate"}
      </Button>
      {!hasFileChanges ? (
        <span id="generate-hint" className="sr-only">No file changes to summarize</span>
      ) : null}
    </div>
  );
}
