// apps/web/src/components/chat/UsagePopover.tsx
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useThreadStore } from "../../stores/threadStore";
import { useThreadRecord } from "../../stores/thread-selectors";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts";
import type { ThreadContextUsage } from "@/stores/thread-record";
import { useEffect, useRef, type ReactNode } from "react";
import { formatUsageResetText } from "@/lib/usage-reset-format";

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
  const resetText = formatUsageResetText(category.resetDate);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{category.label}</span>
        <span className={percent >= 0.8 ? "text-destructive" : "text-foreground/70"}>
          {category.isUnlimited ? "unlimited" : usedDisplay}
        </span>
      </div>
      {!category.isUnlimited && (
        <>
          <UsageBar
            percent={percent}
            label={resetText ? `${category.label} usage. ${resetText}` : `${category.label} usage`}
          />
          {resetText ? (
            <div className="font-mono text-xs tabular-nums text-muted-foreground/70">
              {resetText}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function UsageProviderHeader({
  providerId,
  model,
  contextEntry,
  usageStatus,
}: {
  providerId: string;
  model: string | null | undefined;
  contextEntry: ThreadContextUsage | undefined;
  usageStatus: ProviderUsageInfo["usageStatus"] | undefined;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm font-medium capitalize">{providerId}</div>
        {model ? (
          <div className="text-xs text-muted-foreground">
            {model}
            {contextEntry?.costMultiplier != null && ` · ${contextEntry.costMultiplier}×`}
          </div>
        ) : null}
      </div>
      {usageStatus === "stale" ? (
        <div className="text-right font-mono text-xs uppercase tracking-wider text-muted-foreground/60">STALE</div>
      ) : null}
    </div>
  );
}

function UsageQuotaSection({ usageInfo }: { usageInfo: ProviderUsageInfo | undefined }) {
  const categories = usageInfo?.quotaCategories ?? [];
  if (categories.length === 0) {
    const unavailableMessage = usageInfo?.usageStatus === "unsupported"
      ? "Usage not supported for this provider"
      : usageInfo?.usageStatus === "ready-empty"
        ? "No capped quota reported"
        : "Usage unavailable";
    return <div className="text-xs text-muted-foreground">{unavailableMessage}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60">Quota</div>
      {categories.map((category) => <QuotaRow key={category.label} category={category} />)}
    </div>
  );
}

function UsageRefreshStatus({ usageInfo }: { usageInfo: ProviderUsageInfo | undefined }) {
  const status = usageInfo?.usageStatus;
  if (!usageInfo || (status !== "stale" && status !== "unavailable")) return null;
  const detail = status === "stale"
    ? `Could not refresh. Showing last update from ${usageInfo.fetchedAt ?? "this session"}.`
    : "Usage unavailable.";
  return <div className="text-xs text-muted-foreground">{detail}{usageInfo.diagnostic ? ` ${usageInfo.diagnostic}` : ""}</div>;
}

function ContextUsage({ contextEntry }: { contextEntry: ThreadContextUsage | undefined }) {
  const tokensIn = contextEntry?.lastTokensIn ?? 0;
  const contextWindow = contextEntry?.contextWindow;
  if (tokensIn === 0 || !contextWindow) return null;
  return (
    <div className="space-y-1 border-t border-border pt-2">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60">Context window</div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Used</span>
        <span className="text-foreground/70">{formatTokens(tokensIn)} / {formatTokens(contextWindow)}</span>
      </div>
      <UsageBar percent={tokensIn / contextWindow} label={`Context usage: ${formatTokens(tokensIn)} of ${formatTokens(contextWindow)} tokens`} />
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-muted/40 px-2 py-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xs text-foreground/80">{formatTokens(value)}</div>
    </div>
  );
}

function CacheUsageMetrics({ contextEntry }: { contextEntry: ThreadContextUsage | undefined }) {
  return (
    <>
      {contextEntry?.cacheReadTokens != null ? <UsageMetric label="cache read" value={contextEntry.cacheReadTokens} /> : null}
      {contextEntry?.cacheWriteTokens != null ? <UsageMetric label="cache write" value={contextEntry.cacheWriteTokens} /> : null}
    </>
  );
}

function LastTurnUsage({ contextEntry }: { contextEntry: ThreadContextUsage | undefined }) {
  const tokensIn = contextEntry?.lastTokensIn ?? 0;
  const tokensOut = contextEntry?.tokensOut ?? 0;
  if (tokensIn === 0 && tokensOut === 0) return <div className="border-t border-border pt-2 text-xs text-muted-foreground">No turn data yet</div>;
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60">Last turn</div>
      <div className="grid grid-cols-2 gap-1.5">
        <UsageMetric label="in" value={tokensIn} />
        <UsageMetric label="out" value={tokensOut} />
        <CacheUsageMetrics contextEntry={contextEntry} />
      </div>
    </div>
  );
}

function UsagePopoverDetails({
  providerId,
  model,
  contextEntry,
  usageInfo,
}: {
  providerId: string;
  model: string | null | undefined;
  contextEntry: ThreadContextUsage | undefined;
  usageInfo: ProviderUsageInfo | undefined;
}) {
  const sessionCost = usageInfo?.sessionCostUsd;
  return (
    <div className="space-y-3 p-3">
      <UsageProviderHeader providerId={providerId} model={model} contextEntry={contextEntry} usageStatus={usageInfo?.usageStatus} />
      <UsageQuotaSection usageInfo={usageInfo} />
      <UsageRefreshStatus usageInfo={usageInfo} />
      {sessionCost != null ? (
        <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
          <span className="text-muted-foreground">Session cost</span>
          <span className="text-foreground/70">${sessionCost.toFixed(4)}</span>
        </div>
      ) : null}
      <ContextUsage contextEntry={contextEntry} />
      <LastTurnUsage contextEntry={contextEntry} />
    </div>
  );
}

/** Usage popover showing quota, context window, and last turn data. */
export function UsagePopover({ threadId, children, onOpenChange, side = "top", align = "end" }: UsagePopoverProps) {
  const contextEntry = useThreadRecord(threadId, (r) => r.context);
  const activeThread = useWorkspaceStore((s) => s.threads.find((t) => t.id === threadId));
  const providerId = activeThread?.provider ?? "claude";
  const usageInfo = useThreadRecord(threadId, (r) => r.usageByProvider[providerId]);
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

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger render={<span style={{ display: "contents" }} />}>
        {children}
      </PopoverTrigger>
      <PopoverContent side={side} align={align} sideOffset={8} className="w-72 p-0">
        <UsagePopoverDetails providerId={providerId} model={activeThread?.model} contextEntry={contextEntry} usageInfo={usageInfo} />
      </PopoverContent>
    </Popover>
  );
}
