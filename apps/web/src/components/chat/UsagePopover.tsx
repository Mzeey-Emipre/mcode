// apps/web/src/components/chat/UsagePopover.tsx
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { QuotaCategory } from "@mcode/contracts";
import { useEffect, useRef, type ReactNode } from "react";

interface UsagePopoverProps {
  threadId: string | undefined;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

/** Format token counts for display (e.g., 1500 → "1.5k"). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Days until a quota reset date. */
function daysUntil(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const diff = new Date(iso).getTime() - Date.now();
  return diff > 0 ? Math.ceil(diff / 86_400_000) : 0;
}

/** Horizontal fill bar for usage visualization. */
function UsageBar({ percent, className, label }: { percent: number; className?: string; label?: string }) {
  const color =
    percent >= 0.9 ? "bg-destructive" :
    percent >= 0.7 ? "bg-amber-500" :
    "bg-emerald-500";
  const valuenow = Math.round(Math.min(percent * 100, 100));
  return (
    <div className="h-1 w-full rounded-full bg-muted">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valuenow}
        aria-label={label}
        className={`h-1 rounded-full transition-all ${color} ${className ?? ""}`}
        style={{ width: `${valuenow}%` }}
      />
    </div>
  );
}

/** Single quota category row with label, usage, and progress bar. */
function QuotaRow({ category }: { category: QuotaCategory }) {
  const usedDisplay = category.isUnlimited
    ? `${category.used}`
    : category.total != null
      ? `${category.used} / ${category.total}`
      : `${category.used}`;
  const percent = category.isUnlimited ? 0 : (1 - category.remainingPercent);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{category.label}</span>
        <span className={percent >= 0.8 ? "text-destructive" : "text-foreground/70"}>
          {category.isUnlimited ? "unlimited" : usedDisplay}
        </span>
      </div>
      {!category.isUnlimited && <UsageBar percent={percent} label={`${category.label} usage`} />}
    </div>
  );
}

/** Usage popover showing quota, context window, and last turn data. */
export function UsagePopover({ threadId, children, onOpenChange, side = "top", align = "end" }: UsagePopoverProps) {
  const contextEntry = useThreadStore((s) => threadId ? s.contextByThread[threadId] : undefined);
  const activeThread = useWorkspaceStore((s) => s.threads.find((t) => t.id === threadId));
  const providerId = activeThread?.provider ?? "claude";
  const usageKey = threadId ? `${threadId}:${providerId}` : null;
  const usageInfo = useThreadStore((s) => usageKey ? s.usageByProvider[usageKey] : undefined);
  const fetchProviderUsage = useThreadStore((s) => s.fetchProviderUsage);
  const hasFetched = useRef(false);

  const handleOpenChange = (open: boolean) => {
    if (open && !hasFetched.current && threadId) {
      hasFetched.current = true;
      fetchProviderUsage(threadId, providerId);
    }
    onOpenChange?.(open);
  };

  // Reset fetch flag when thread or provider changes
  useEffect(() => {
    hasFetched.current = false;
  }, [threadId, providerId]);

  const categories = usageInfo?.quotaCategories ?? [];
  const sessionCost = usageInfo?.sessionCostUsd;
  const tokensIn = contextEntry?.lastTokensIn ?? 0;
  const tokensOut = contextEntry?.tokensOut ?? 0;
  const contextWindow = contextEntry?.contextWindow;
  const hasContext = tokensIn > 0 && contextWindow;
  const hasTurn = tokensIn > 0 || tokensOut > 0;

  // Earliest reset date across quota categories
  const resetDays = categories
    .map((c) => daysUntil(c.resetDate))
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b)[0];

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger render={<span style={{ display: "contents" }} />}>
        {children}
      </PopoverTrigger>
      <PopoverContent side={side} align={align} sideOffset={8} className="w-72 p-0">
        <div className="space-y-3 p-3">
          {/* Provider header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium capitalize">{providerId}</div>
              {activeThread?.model && (
                <div className="text-[10px] text-muted-foreground">
                  {activeThread.model}
                  {contextEntry?.costMultiplier != null && ` · ${contextEntry.costMultiplier}×`}
                </div>
              )}
            </div>
            {resetDays !== undefined && (
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground">resets in</div>
                <div className="text-xs text-foreground/70">{resetDays}d</div>
              </div>
            )}
          </div>

          {/* Quota section */}
          {categories.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Quota
              </div>
              {categories.map((cat) => (
                <QuotaRow key={cat.label} category={cat} />
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Quota data not available for this provider
            </div>
          )}

          {/* Session cost (Claude only) */}
          {sessionCost != null && (
            <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
              <span className="text-muted-foreground">Session cost</span>
              <span className="text-foreground/70">${sessionCost.toFixed(4)}</span>
            </div>
          )}

          {/* Context window section */}
          {hasContext && (
            <div className="space-y-1 border-t border-border pt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Context window
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Used</span>
                <span className="text-foreground/70">
                  {formatTokens(tokensIn)} / {formatTokens(contextWindow)}
                </span>
              </div>
              <UsageBar
                percent={tokensIn / contextWindow}
                label={`Context usage: ${formatTokens(tokensIn)} of ${formatTokens(contextWindow)} tokens`}
              />
            </div>
          )}

          {/* Last turn section */}
          {hasTurn ? (
            <div className="space-y-2 border-t border-border pt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Last turn
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="rounded bg-muted/40 px-2 py-1.5">
                  <div className="text-[9px] text-muted-foreground">in</div>
                  <div className="text-xs text-foreground/80">{formatTokens(tokensIn)}</div>
                </div>
                <div className="rounded bg-muted/40 px-2 py-1.5">
                  <div className="text-[9px] text-muted-foreground">out</div>
                  <div className="text-xs text-foreground/80">
                    {formatTokens(tokensOut)}
                  </div>
                </div>
                {contextEntry?.cacheReadTokens != null && (
                  <div className="rounded bg-muted/40 px-2 py-1.5">
                    <div className="text-[9px] text-muted-foreground">cache read</div>
                    <div className="text-xs text-foreground/80">{formatTokens(contextEntry.cacheReadTokens)}</div>
                  </div>
                )}
                {contextEntry?.cacheWriteTokens != null && (
                  <div className="rounded bg-muted/40 px-2 py-1.5">
                    <div className="text-[9px] text-muted-foreground">cache write</div>
                    <div className="text-xs text-foreground/80">{formatTokens(contextEntry.cacheWriteTokens)}</div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="border-t border-border pt-2 text-xs text-muted-foreground">
              No turn data yet
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
