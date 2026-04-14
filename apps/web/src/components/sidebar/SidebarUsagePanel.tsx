import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { cn } from "@/lib/utils";
import type { QuotaCategory } from "@mcode/contracts";

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function daysUntil(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const diff = new Date(iso).getTime() - Date.now();
  return diff > 0 ? Math.ceil(diff / 86_400_000) : 0;
}

function barFill(cat: QuotaCategory): string {
  const used = 1 - cat.remainingPercent;
  if (used >= 0.9) return "bg-red-400";
  if (used >= 0.7) return "bg-amber-400";
  return "bg-emerald-400";
}

function compactFill(cat: QuotaCategory): string {
  const used = 1 - cat.remainingPercent;
  if (used >= 0.9) return "bg-destructive";
  if (used >= 0.7) return "bg-amber-500";
  return "bg-foreground/20";
}

/** Single quota row — bar for limited, ∞ badge for unlimited. */
function QuotaRow({ cat }: { cat: QuotaCategory }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[11px] text-gray-500">{cat.label}</span>
        {cat.isUnlimited ? (
          <span className="shrink-0 text-[11px] text-gray-300">∞</span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-gray-400">
            {abbrev(cat.used)}&thinsp;/&thinsp;{abbrev(cat.total ?? 0)}
          </span>
        )}
      </div>
      {!cat.isUnlimited && (
        <div className="h-[3px] w-full rounded-full bg-gray-100">
          <div
            className={cn(
              "h-[3px] rounded-full transition-[width] duration-700 ease-out",
              barFill(cat),
            )}
            style={{ width: `${Math.min((1 - cat.remainingPercent) * 100, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Compact always-visible instrument strip in the sidebar footer.
 * Shows razor-thin bars — no labels. Hovering reveals a white
 * floating card with full quota, context, and turn breakdown.
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

  const usageInfo = useThreadStore((s) => s.usageByProvider[providerId]);
  const contextEntry = useThreadStore((s) =>
    activeThreadId ? s.contextByThread[activeThreadId] : undefined,
  );
  const fetchProviderUsage = useThreadStore((s) => s.fetchProviderUsage);

  // Hydrate immediately — bars appear without waiting for a hover.
  useEffect(() => {
    if (activeThreadId && !usageInfo) {
      void fetchProviderUsage(providerId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const tokensIn = contextEntry?.lastTokensIn ?? 0;
  const tokensOut = contextEntry?.tokensOut ?? 0;
  const cacheRead = contextEntry?.cacheReadTokens ?? 0;
  const cacheWrite = contextEntry?.cacheWriteTokens ?? 0;
  const hasTurn = tokensIn > 0 || tokensOut > 0;

  const resetDays = limitedCats
    .map((c) => daysUntil(c.resetDate))
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b)[0];

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
            <span className="truncate text-[11px] font-medium tracking-tight text-foreground/65">
              {(displayModel?.split("/").pop() ?? providerId)}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/40">
              {sessionCost != null
                ? `$${sessionCost.toFixed(2)}`
                : mostConstrained
                  ? `${abbrev(mostConstrained.used)}/${abbrev(mostConstrained.total ?? 0)}`
                  : null}
            </span>
          </div>

          {/* Representative bar */}
          {mostConstrained ? (
            <div className="h-[2px] w-full rounded-full bg-border/30">
              <div
                className={cn("h-[2px] rounded-full transition-[width] duration-700 ease-out", compactFill(mostConstrained))}
                style={{ width: `${Math.min((1 - mostConstrained.remainingPercent) * 100, 100)}%` }}
              />
            </div>
          ) : hasContext ? (
            <div className="h-[2px] w-full rounded-full bg-border/20">
              <div
                className="h-[2px] rounded-full bg-foreground/20 transition-[width] duration-700 ease-out"
                style={{ width: `${Math.min((ctxTokens / ctxWindow!) * 100, 100)}%` }}
              />
            </div>
          ) : (
            <div className="h-[2px] w-full rounded-full bg-border/15" />
          )}
        </div>
      </PopoverTrigger>

      {/* ── White hover panel ── */}
      <PopoverContent
        side="right"
        align="end"
        sideOffset={12}
        className="w-60 p-0 !bg-white !border-black/[0.06] !shadow-[0_16px_48px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden !rounded-2xl"
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-4 pt-4 pb-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold capitalize tracking-tight text-gray-900 leading-none">
              {providerId}
            </div>
            {displayModel && (
              <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400 leading-tight">
                {displayModel.split("/").pop()}
              </div>
            )}
          </div>
          {resetDays !== undefined && (
            <span className="shrink-0 ml-3 mt-0.5 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] tabular-nums text-gray-500">
              {resetDays}d left
            </span>
          )}
        </div>

        {/* Quota — all categories */}
        {categories.length > 0 && (
          <div className="border-t border-gray-100 px-4 py-3 space-y-3">
            {categories.map((cat) => (
              <QuotaRow key={cat.label} cat={cat} />
            ))}
          </div>
        )}

        {/* Session stats — cost, tier, turns, duration */}
        {(sessionCost != null || serviceTier || numTurns != null || durationMs != null) && (
          <div className="border-t border-gray-100 px-4 py-3 space-y-2">
            {sessionCost != null && (
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] text-gray-400">session cost</span>
                <span className="font-mono text-[12px] font-medium tabular-nums text-gray-700">
                  ${sessionCost.toFixed(4)}
                </span>
              </div>
            )}
            {(numTurns != null || durationMs != null || serviceTier) && (
              <div className="flex items-center gap-2 flex-wrap">
                {numTurns != null && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] tabular-nums text-gray-500">
                    {numTurns} {numTurns === 1 ? "turn" : "turns"}
                  </span>
                )}
                {durationMs != null && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] tabular-nums text-gray-500">
                    {durationMs >= 60_000
                      ? `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`
                      : `${(durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
                {serviceTier && serviceTier !== "standard" && (
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-500 capitalize">
                    {serviceTier}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Context window */}
        {hasContext && (
          <div className="border-t border-gray-100 px-4 py-3 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-gray-500">context</span>
              <span className="font-mono text-[10px] tabular-nums text-gray-400">
                {abbrev(ctxTokens)}&thinsp;/&thinsp;{abbrev(ctxWindow!)}
              </span>
            </div>
            <div className="h-[3px] w-full rounded-full bg-gray-100">
              <div
                className="h-[3px] rounded-full bg-gray-300 transition-[width] duration-700 ease-out"
                style={{ width: `${Math.min((ctxTokens / ctxWindow!) * 100, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Last turn — clean stat grid */}
        {hasTurn && (
          <div className="border-t border-gray-100 px-4 py-3">
            <div className="text-[9px] font-medium uppercase tracking-wider text-gray-300 mb-2">last turn</div>
            <div className="flex items-end gap-4">
              {tokensIn > 0 && (
                <div>
                  <span className="font-mono text-[14px] font-semibold leading-none text-gray-800">
                    {abbrev(tokensIn)}
                  </span>
                  <div className="text-[9px] text-gray-400 mt-0.5">in</div>
                </div>
              )}
              {tokensOut > 0 && (
                <div>
                  <span className="font-mono text-[14px] font-semibold leading-none text-gray-800">
                    {abbrev(tokensOut)}
                  </span>
                  <div className="text-[9px] text-gray-400 mt-0.5">out</div>
                </div>
              )}
              {cacheRead > 0 && (
                <div>
                  <span className="font-mono text-[14px] font-semibold leading-none text-gray-800">
                    {abbrev(cacheRead)}
                  </span>
                  <div className="text-[9px] text-gray-400 mt-0.5">cached</div>
                </div>
              )}
              {cacheWrite > 0 && (
                <div>
                  <span className="font-mono text-[14px] font-semibold leading-none text-gray-800">
                    {abbrev(cacheWrite)}
                  </span>
                  <div className="text-[9px] text-gray-400 mt-0.5">written</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* No data at all yet for this provider */}
        {usageInfo && categories.length === 0 && sessionCost == null && numTurns == null && !hasTurn && !hasContext && (
          <div className="border-t border-gray-100 px-4 py-3">
            <span className="text-[11px] text-gray-400">Send a message to see usage</span>
          </div>
        )}

        {!usageInfo && !hasContext && (
          <div className="border-t border-gray-100 px-4 py-3">
            <span className="text-[11px] text-gray-400">Loading…</span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
