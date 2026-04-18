import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { cn } from "@/lib/utils";
import type { QuotaCategory } from "@mcode/contracts";

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  // Keep one decimal in the 1k–10k range so 1420/1500 doesn't collapse
  // to "1k / 2k" and hide the fact the user is at 95% of weekly quota.
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format a USD amount with units that match what a developer actually budgets by.
 * Sub-cent amounts collapse to `<$0.01`; everything else shows two decimal places.
 */
function formatCost(usd: number | undefined | null): string | undefined {
  if (usd == null) return undefined;
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

interface TimeUntil {
  text: string;
  urgent: boolean;
}

/**
 * Turn an ISO reset timestamp into a scale-appropriate countdown. Unlike the
 * previous day-granularity formatter, this drops to hours under a day and
 * minutes under an hour, and flags the result as urgent when <1h remains.
 */
function formatTimeUntil(iso: string | undefined): TimeUntil | undefined {
  if (!iso) return undefined;
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return { text: "now", urgent: true };
  // Minutes bucket: anything that would round to 60m flips to the hours bucket
  // so we never render the awkward "resets 60m".
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return { text: `${minutes}m`, urgent: true };
  if (diff < 24 * 60 * 60_000) {
    return { text: `${Math.round(diff / (60 * 60_000))}h`, urgent: diff < 2 * 60 * 60_000 };
  }
  return { text: `${Math.ceil(diff / 86_400_000)}d`, urgent: false };
}

function pressure(usedPercent: number): "safe" | "warn" | "crit" {
  if (usedPercent >= 0.9) return "crit";
  if (usedPercent >= 0.7) return "warn";
  return "safe";
}

function barFill(cat: QuotaCategory): string {
  switch (pressure(1 - cat.remainingPercent)) {
    case "crit": return "bg-destructive";
    case "warn": return "bg-primary";
    default: return "bg-emerald-500";
  }
}

function contextFill(usedPercent: number): string {
  switch (pressure(usedPercent)) {
    case "crit": return "bg-destructive";
    case "warn": return "bg-primary";
    default: return "bg-foreground/30";
  }
}

function compactFill(cat: QuotaCategory): string {
  switch (pressure(1 - cat.remainingPercent)) {
    case "crit": return "bg-destructive";
    case "warn": return "bg-primary";
    default: return "bg-foreground/25";
  }
}

/** Single quota row — bar for limited, ∞ badge for unlimited. */
function QuotaRow({ cat }: { cat: QuotaCategory }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[11px] text-muted-foreground">{cat.label}</span>
        {cat.isUnlimited ? (
          <span className="shrink-0 text-[11px] text-muted-foreground/50">∞</span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
            {abbrev(cat.used)}&thinsp;/&thinsp;{abbrev(cat.total ?? 0)}
          </span>
        )}
      </div>
      {!cat.isUnlimited && (
        <div
          className="h-[3px] w-full rounded-full bg-border/50"
          role="progressbar"
          aria-label={`${cat.label} quota`}
          aria-valuemin={0}
          aria-valuemax={cat.total ?? 100}
          aria-valuenow={cat.used}
        >
          <div
            className={cn(
              "h-[3px] rounded-full transition-[width] duration-300 ease-out",
              barFill(cat),
            )}
            style={{ width: `${Math.min((1 - cat.remainingPercent) * 100, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** Small uppercase section label — the instrument-panel tracker. */
function SectionLabel({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <div
      className={cn(
        "text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/60",
        align === "right" && "text-right",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Compact always-visible instrument strip in the sidebar footer.
 * Shows razor-thin bars — no labels. Hovering reveals a floating
 * card with full quota, context, and turn breakdown, styled to sit
 * inside the dark app shell rather than float above it as a system dialog.
 */
export function SidebarUsagePanel() {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeThread = useWorkspaceStore((s) =>
    s.threads.find((t) => t.id === s.activeThreadId),
  );
  // Prefer the live composer draft model (updates on every dropdown change)
  // over the thread record which only reflects the last sent message.
  const draftModel = useComposerDraftStore((s) =>
    activeThreadId ? s.drafts[activeThreadId]?.modelId : undefined,
  );
  const displayModel = draftModel ?? activeThread?.model ?? undefined;

  const providerId = (activeThread?.provider ?? "claude") as string;

  const usageKey = activeThreadId ? `${activeThreadId}:${providerId}` : null;
  const usageInfo = useThreadStore((s) => usageKey ? s.usageByProvider[usageKey] : undefined);
  const contextEntry = useThreadStore((s) =>
    activeThreadId ? s.contextByThread[activeThreadId] : undefined,
  );
  const fetchProviderUsage = useThreadStore((s) => s.fetchProviderUsage);

  // Hydrate immediately — bars appear without waiting for a hover.
  // fetchProviderUsage is a stable Zustand store action.
  useEffect(() => {
    if (activeThreadId && !usageInfo) {
      void fetchProviderUsage(activeThreadId, providerId);
    }
  }, [activeThreadId, providerId]);

  if (!activeThreadId) return null;

  const categories = usageInfo?.quotaCategories ?? [];
  const limitedCats = categories.filter((c) => !c.isUnlimited);
  const sessionCost = usageInfo?.sessionCostUsd;
  const serviceTier = usageInfo?.serviceTier;
  const numTurns = usageInfo?.numTurns;
  const durationMs = usageInfo?.durationMs;
  // Most constrained limited category — drives the compact strip bar and metric.
  const mostConstrained = limitedCats.length > 0
    ? limitedCats.reduce((a, b) => a.remainingPercent < b.remainingPercent ? a : b)
    : null;

  const ctxTokens = contextEntry?.lastTokensIn ?? 0;
  const ctxWindow = contextEntry?.contextWindow;
  const hasContext = ctxTokens > 0 && !!ctxWindow;
  const ctxRatio = hasContext ? ctxTokens / ctxWindow! : 0;
  const ctxPressure = pressure(ctxRatio);

  const tokensIn = contextEntry?.lastTokensIn ?? 0;
  const tokensOut = contextEntry?.tokensOut ?? 0;
  const cacheRead = contextEntry?.cacheReadTokens ?? 0;
  const cacheWrite = contextEntry?.cacheWriteTokens ?? 0;
  const hasTurn = tokensIn > 0 || tokensOut > 0;
  // Cache hit rate: fraction of the turn's total input that came from cache.
  // This is the headline cost-saving metric for Claude — reused across turns.
  const cacheHitRate = cacheRead > 0 && (cacheRead + tokensIn) > 0
    ? Math.round((cacheRead / (cacheRead + tokensIn)) * 100)
    : undefined;

  // Earliest reset across limited categories drives the header countdown.
  const earliestReset = limitedCats
    .map((c) => c.resetDate)
    .filter((d): d is string => !!d)
    .sort()[0];
  const resetBadge = formatTimeUntil(earliestReset);

  // Any red-level pressure triggers a single consolidated hint row.
  const quotaCritical = limitedCats.some((c) => pressure(1 - c.remainingPercent) === "crit");
  const hintText = ctxPressure === "crit"
    ? "Context near limit · consider compacting or starting fresh"
    : quotaCritical
      ? "Quota almost exhausted · switch model or wait for reset"
      : undefined;

  const costLabel = formatCost(sessionCost);

  const show = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimeout(closeTimer.current);
    setOpen(true);
  };

  const hide = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>

      {/* ── Compact strip ── */}
      <PopoverTrigger
        render={
          <div
            className="w-full cursor-default py-0.5"
            onMouseEnter={show}
            onMouseLeave={hide}
          />
        }
      >
        <div className="space-y-1.5">
          {/* Model name + key metric */}
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[11px] font-medium tracking-tight text-foreground/70">
              {(displayModel?.split("/").pop() ?? providerId)}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/45">
              {costLabel ??
                (mostConstrained
                  ? `${abbrev(mostConstrained.used)}/${abbrev(mostConstrained.total ?? 0)}`
                  : null)}
            </span>
          </div>

          {/* Representative bar */}
          {mostConstrained ? (
            <div
              className="h-[2px] w-full rounded-full bg-border/40"
              role="progressbar"
              aria-label={`${mostConstrained.label} quota`}
              aria-valuemin={0}
              aria-valuemax={mostConstrained.total ?? 100}
              aria-valuenow={mostConstrained.used}
            >
              <div
                className={cn(
                  "h-[2px] rounded-full transition-[width] duration-300 ease-out",
                  compactFill(mostConstrained),
                )}
                style={{ width: `${Math.min((1 - mostConstrained.remainingPercent) * 100, 100)}%` }}
              />
            </div>
          ) : hasContext ? (
            <div
              className="h-[2px] w-full rounded-full bg-border/40"
              role="progressbar"
              aria-label="Context window"
              aria-valuemin={0}
              aria-valuemax={ctxWindow}
              aria-valuenow={ctxTokens}
            >
              <div
                className={cn(
                  "h-[2px] rounded-full transition-[width] duration-300 ease-out",
                  contextFill(ctxRatio),
                )}
                style={{ width: `${Math.min(ctxRatio * 100, 100)}%` }}
              />
            </div>
          ) : (
            <div className="h-[2px] w-full rounded-full bg-border/20" aria-hidden />
          )}
        </div>
      </PopoverTrigger>

      {/* ── Instrument-panel popover ── */}
      <PopoverContent
        side="right"
        align="end"
        sideOffset={12}
        className="w-64 p-0 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-4px_rgba(0,0,0,0.6),0_2px_6px_rgba(0,0,0,0.3)]"
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-4 pt-3.5 pb-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold capitalize tracking-tight text-foreground leading-none">
              {providerId}
            </div>
            {displayModel && (
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80 leading-tight">
                {displayModel.split("/").pop()}
              </div>
            )}
          </div>
          {resetBadge && (
            <span
              className={cn(
                "shrink-0 ml-3 mt-0.5 rounded-full px-2 py-0.5 font-mono text-[10px] tabular-nums",
                resetBadge.urgent
                  ? "bg-destructive/15 text-destructive border border-destructive/25"
                  : "bg-muted text-muted-foreground",
              )}
            >
              resets {resetBadge.text}
            </span>
          )}
        </div>

        {/* Quota — all categories */}
        {categories.length > 0 && (
          <div className="border-t border-border/60 px-4 py-3 space-y-2.5">
            <SectionLabel>Quota</SectionLabel>
            {categories.map((cat) => (
              <QuotaRow key={cat.label} cat={cat} />
            ))}
          </div>
        )}

        {/* Session stats — cost, turns, duration, tier */}
        {(costLabel || serviceTier || numTurns != null || durationMs != null) && (
          <div className="border-t border-border/60 px-4 py-3 space-y-2">
            <div className="flex items-baseline justify-between">
              <SectionLabel>Session</SectionLabel>
              {costLabel && (
                <span className="font-mono text-[13px] font-medium tabular-nums text-foreground leading-none">
                  {costLabel}
                </span>
              )}
            </div>
            {(numTurns != null || durationMs != null || serviceTier) && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {numTurns != null && (
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {numTurns}t
                  </span>
                )}
                {durationMs != null && (
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {durationMs >= 60_000
                      ? `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`
                      : durationMs >= 10_000
                        ? `${Math.round(durationMs / 1000)}s`
                        : `${(durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
                {serviceTier && serviceTier !== "standard" && (
                  <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-medium capitalize text-primary">
                    {serviceTier}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Context window */}
        {hasContext && (
          <div className="border-t border-border/60 px-4 py-3 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <SectionLabel>Context</SectionLabel>
              <span
                className={cn(
                  "font-mono text-[10px] tabular-nums",
                  ctxPressure === "crit"
                    ? "text-destructive"
                    : ctxPressure === "warn"
                      ? "text-primary"
                      : "text-muted-foreground",
                )}
              >
                {abbrev(ctxTokens)}&thinsp;/&thinsp;{abbrev(ctxWindow!)}
                <span className="ml-1 text-muted-foreground/60">
                  · {Math.round(ctxRatio * 100)}%
                </span>
              </span>
            </div>
            <div
              className="h-[3px] w-full rounded-full bg-border/50"
              role="progressbar"
              aria-label="Context window"
              aria-valuemin={0}
              aria-valuemax={ctxWindow}
              aria-valuenow={ctxTokens}
            >
              <div
                className={cn(
                  "h-[3px] rounded-full transition-[width] duration-300 ease-out",
                  contextFill(ctxRatio),
                )}
                style={{ width: `${Math.min(ctxRatio * 100, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Last turn — primary numbers, cache stats demoted */}
        {hasTurn && (
          <div className="border-t border-border/60 px-4 py-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <SectionLabel>Last turn</SectionLabel>
              {cacheHitRate != null && (
                <span className="font-mono text-[10px] tabular-nums text-emerald-400/90">
                  {cacheHitRate}% cache hit
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-4">
              {tokensIn > 0 && (
                <span className="font-mono text-[14px] font-semibold leading-none tabular-nums text-foreground">
                  {abbrev(tokensIn)}
                  <span className="ml-1 text-[9px] font-normal text-muted-foreground/60">in</span>
                </span>
              )}
              {tokensOut > 0 && (
                <span className="font-mono text-[14px] font-semibold leading-none tabular-nums text-foreground">
                  {abbrev(tokensOut)}
                  <span className="ml-1 text-[9px] font-normal text-muted-foreground/60">out</span>
                </span>
              )}
            </div>
            {(cacheRead > 0 || cacheWrite > 0) && (
              <div className="mt-2 flex items-baseline gap-3 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                {cacheRead > 0 && <span>{abbrev(cacheRead)} cache read</span>}
                {cacheWrite > 0 && <span>{abbrev(cacheWrite)} cache write</span>}
              </div>
            )}
          </div>
        )}

        {/* Critical-state hint — single actionable nudge when context or quota is red */}
        {hintText && (
          <div
            role="status"
            className="border-t border-border/60 bg-destructive/5 px-4 py-2.5 text-[10px] leading-snug text-destructive/90"
          >
            {hintText}
          </div>
        )}

        {/* No data at all yet for this provider */}
        {usageInfo && categories.length === 0 && !costLabel && numTurns == null && !hasTurn && !hasContext && (
          <div className="border-t border-border/60 px-4 py-3">
            <span className="text-[11px] text-muted-foreground/60">Send a message to see usage</span>
          </div>
        )}

        {!usageInfo && !hasContext && (
          <div className="border-t border-border/60 px-4 py-3">
            <span className="text-[11px] text-muted-foreground/60">Loading…</span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
