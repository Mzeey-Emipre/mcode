import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { cn } from "@/lib/utils";
import type { QuotaCategory } from "@mcode/contracts";

/** Usage ratio at or above which a quota/context bar reads as critical (red). */
const CRIT_THRESHOLD = 0.9;
/** Usage ratio at or above which a bar reads as warn (primary/amber). */
const WARN_THRESHOLD = 0.7;
/** Countdown ratio (hours) below which the reset badge flips to urgent styling. */
const URGENT_HOURS = 2;

/** Pressure level derived from a used-fraction in [0, 1]. */
type Pressure = "safe" | "warn" | "crit";

/**
 * Abbreviate a token count for dense display. Preserves one decimal in the
 * 1k–10k range so 1,420 and 1,500 don't both collapse to "1k / 2k" and hide
 * that the user is at 95% of weekly quota. Rounds to whole units elsewhere.
 */
function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) {
    const scaled = n / 1_000;
    // Decide format from the rounded value so 9,999 (which rounds to 10)
    // renders as "10k" alongside 10,000 instead of the awkward "10.0k to 10k"
    // jump the unrounded scaled>=10 check would produce.
    const rounded = Math.round(scaled);
    return rounded >= 10 ? `${rounded}k` : `${scaled.toFixed(1)}k`;
  }
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

/**
 * Render a millisecond duration in the tightest appropriate unit. Under 10s
 * shows one decimal (`5.4s`); 10s–60s shows whole seconds; above a minute
 * shows `Xm Ys`. Normalizes through a single total-seconds value so the
 * 60_000ms boundary can't render as `1m 60s`.
 */
function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Countdown segment with a flag marking short-window urgency for styling. */
interface TimeUntil {
  text: string;
  urgent: boolean;
}

/**
 * Turn an ISO reset timestamp into a scale-appropriate countdown. Drops to
 * hours under a day, minutes under an hour, flips minutes→hours and hours→days
 * at rounding boundaries so we never render "resets 60m" or "resets 24h".
 * Flags as urgent when under an hour, or under URGENT_HOURS hours.
 */
function formatTimeUntil(iso: string | undefined): TimeUntil | undefined {
  if (!iso) return undefined;
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return { text: "now", urgent: true };

  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return { text: `${minutes}m`, urgent: true };

  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return { text: `${hours}h`, urgent: diff < URGENT_HOURS * 3_600_000 };

  return { text: `${Math.ceil(diff / 86_400_000)}d`, urgent: false };
}

/** Map a used-fraction [0, 1] onto a three-level pressure scale. */
function pressure(usedFraction: number): Pressure {
  if (usedFraction >= CRIT_THRESHOLD) return "crit";
  if (usedFraction >= WARN_THRESHOLD) return "warn";
  return "safe";
}

/**
 * Single Tailwind class for a pressure level. `safeClass` lets callers pick
 * the neutral colour — bars inside the popover use a stronger emerald tint,
 * the compact strip footer uses a low-contrast foreground/25 fill.
 */
function fillForPressure(level: Pressure, safeClass: string): string {
  if (level === "crit") return "bg-destructive";
  if (level === "warn") return "bg-primary";
  return safeClass;
}

/**
 * Single quota row inside the popover. Renders a bar when the category
 * reports a numeric limit, an ∞ badge when unlimited, and a plain used count
 * when the provider declares the category limited but omits the cap (rare —
 * in that case we skip both the bar and ARIA progressbar semantics since
 * `aria-valuemax` would be undefined).
 */
function QuotaRow({ cat }: { cat: QuotaCategory }) {
  const hasLimit = !cat.isUnlimited && cat.total != null && cat.total > 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[11px] text-muted-foreground">{cat.label}</span>
        {cat.isUnlimited ? (
          <span className="shrink-0 text-[11px] text-muted-foreground/50">∞</span>
        ) : hasLimit ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
            {abbrev(cat.used)}&thinsp;/&thinsp;{abbrev(cat.total!)}
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
            {abbrev(cat.used)}
          </span>
        )}
      </div>
      {hasLimit && (
        <div
          className="h-[3px] w-full rounded-full bg-border/50"
          role="progressbar"
          aria-label={`${cat.label} quota`}
          aria-valuemin={0}
          aria-valuemax={cat.total!}
          aria-valuenow={cat.used}
        >
          <div
            className={cn(
              "h-[3px] rounded-full transition-[width] duration-300 ease-out",
              fillForPressure(pressure(1 - cat.remainingPercent), "bg-emerald-500"),
            )}
            style={{ width: `${Math.min((1 - cat.remainingPercent) * 100, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** Small uppercase section label — the instrument-panel tracker. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/60">
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

  // Hydrate immediately — bars appear without waiting for a hover. Intentionally
  // omit fetchProviderUsage (stable Zustand action) and usageInfo (the guard)
  // from deps so thread switches don't re-trigger a fetch mid-request.
  useEffect(() => {
    if (activeThreadId && !usageInfo) {
      void fetchProviderUsage(activeThreadId, providerId);
    }
  }, [activeThreadId, providerId]);

  // Clear any in-flight close timer when the component unmounts so a late
  // setOpen(false) can't fire against a destroyed component.
  useEffect(() => () => clearTimeout(closeTimer.current), []);

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
  // Cache hit rate: fraction of the turn's input that came from cache.
  // The Claude adapter already folds cache_read_input_tokens and
  // cache_creation_input_tokens into tokensIn, so tokensIn is the
  // correct denominator — adding cacheRead again would double-count.
  // Clamp to 100 defensively: out-of-order events from other providers
  // can temporarily report cacheRead above tokensIn, and "422% cache
  // hit" is never a correct display.
  const cacheHitRate = cacheRead > 0 && tokensIn > 0
    ? Math.min(100, Math.round((cacheRead / tokensIn) * 100))
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

  const show = (e: React.SyntheticEvent) => {
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
            role="button"
            tabIndex={0}
            aria-label="Show usage details"
            aria-expanded={open}
            className="w-full cursor-default py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:ring-offset-0 rounded"
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={show}
            onBlur={hide}
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
                  ? mostConstrained.total != null
                    ? `${abbrev(mostConstrained.used)}/${abbrev(mostConstrained.total)}`
                    : abbrev(mostConstrained.used)
                  : null)}
            </span>
          </div>

          {/* Representative bar */}
          {mostConstrained && mostConstrained.total != null && mostConstrained.total > 0 ? (
            <div
              className="h-[2px] w-full rounded-full bg-border/40"
              role="progressbar"
              aria-label={`${mostConstrained.label} quota`}
              aria-valuemin={0}
              aria-valuemax={mostConstrained.total}
              aria-valuenow={mostConstrained.used}
            >
              <div
                className={cn(
                  "h-[2px] rounded-full transition-[width] duration-300 ease-out",
                  fillForPressure(pressure(1 - mostConstrained.remainingPercent), "bg-foreground/25"),
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
                  fillForPressure(ctxPressure, "bg-foreground/25"),
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
        onFocus={show}
        onBlur={hide}
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
                    {formatDuration(durationMs)}
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
                  fillForPressure(ctxPressure, "bg-emerald-500"),
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
