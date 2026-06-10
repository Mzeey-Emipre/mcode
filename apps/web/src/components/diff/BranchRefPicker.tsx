import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { BranchComparison, GitBranch } from "@mcode/contracts";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";

/** The scope key a comparison is resolved against (`workspaceId:threadId`). */
function scopeKey(workspaceId: string, threadId?: string): string {
  return `${workspaceId}:${threadId ?? ""}`;
}

/**
 * Resolves the default Branch comparison for a scope (per ADR 0007) and seeds it
 * into the diff store. Re-resolves when the scope changes; preserves a user's
 * picked pair when the active comparison was already resolved for this scope (so
 * toggling views within a scope keeps the chosen base/target). Returns the
 * current comparison plus whether the initial resolve is in flight.
 */
function useResolveBranchComparison(
  workspaceId: string,
  threadId?: string,
): { comparison: BranchComparison | null; loading: boolean } {
  const comparison = useDiffStore((s) => s.branchComparison);
  const setBranchComparison = useDiffStore((s) => s.setBranchComparison);
  const [loading, setLoading] = useState(false);
  const key = scopeKey(workspaceId, threadId);

  useEffect(() => {
    // Keep the pair the user already resolved/picked for this exact scope.
    const state = useDiffStore.getState();
    if (state.branchComparisonKey === key && state.branchComparison) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void getTransport()
      .getBranchComparison(workspaceId, threadId)
      .then((result) => {
        if (cancelled) return;
        setBranchComparison(result, key);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setBranchComparison({ base: null, target: null, refs: [], isUnborn: false }, key);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, threadId, setBranchComparison]);

  return { comparison, loading };
}

/** Human-readable group label for a ref type in the picker menu. */
const REF_GROUP_LABEL: Record<GitBranch["type"], string> = {
  local: "Local",
  worktree: "Worktrees",
  remote: "Remotes",
};

/** One side (base or target) of the comparison: a dropdown labelled with the chosen ref. */
function RefDropdown({
  side,
  value,
  refs,
  onSelect,
}: {
  side: "base" | "target";
  value: string | null;
  refs: readonly GitBranch[];
  onSelect: (ref: string) => void;
}) {
  // Catalog order already groups by type (local → worktree → remote); render
  // group headers as the type changes so the menu reads as sections.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`branch-${side}-picker`}
        aria-label={`Select ${side} ref`}
        className="flex h-6 min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tracking-tight text-foreground hover:bg-accent"
      >
        <span className="max-w-[140px] truncate font-mono">{value ?? "Select…"}</span>
        <ChevronDown size={11} className="shrink-0 text-muted-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="max-h-[320px] min-w-[180px] overflow-y-auto">
        {refs.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No refs</div>
        ) : (
          refs.map((ref, i) => {
            const active = ref.name === value;
            const showHeader = i === 0 || refs[i - 1].type !== ref.type;
            return (
              <div key={`${ref.type}:${ref.name}`}>
                {showHeader && (
                  <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    {REF_GROUP_LABEL[ref.type]}
                  </div>
                )}
                <DropdownMenuItem
                  onClick={() => onSelect(ref.name)}
                  data-testid={`branch-ref-${side}-${ref.name}`}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-2 py-1 text-xs",
                    active ? "text-foreground" : "text-popover-foreground",
                  )}
                >
                  <span className="flex-1 truncate text-left font-mono">{ref.name}</span>
                  {ref.isCurrent && (
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground/50">
                      current
                    </span>
                  )}
                  {active && <Check size={11} className="shrink-0 text-muted-foreground" />}
                </DropdownMenuItem>
              </div>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Props for {@link BranchRefPicker}. */
interface BranchRefPickerProps {
  /** Active workspace id (the repo whose refs populate the pickers). */
  workspaceId: string;
  /** Active thread id; makes "current branch" the thread's worktree branch. */
  threadId?: string;
}

/**
 * The Branch view's operand control: two ref dropdowns (`base … target`) the user
 * picks independently, always diffed three-dot. Renders into the Review toolbar's
 * contextual operand slot. Resolves its default pair per ADR 0007 and writes the
 * chosen pair to the diff store, which drives the rendered Branch diff.
 */
export function BranchRefPicker({ workspaceId, threadId }: BranchRefPickerProps) {
  const { comparison, loading } = useResolveBranchComparison(workspaceId, threadId);
  const setBranchBase = useDiffStore((s) => s.setBranchBase);
  const setBranchTarget = useDiffStore((s) => s.setBranchTarget);

  if (loading && !comparison) {
    return <span className="text-[11px] text-muted-foreground/50">Loading refs…</span>;
  }
  if (comparison?.isUnborn) {
    return <span className="text-[11px] text-muted-foreground/50">No commits yet</span>;
  }

  const refs = comparison?.refs ?? [];
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-testid="branch-ref-picker">
      <RefDropdown side="base" value={comparison?.base ?? null} refs={refs} onSelect={setBranchBase} />
      {/* Three-dot range indicator (always `base...target`, never two-dot). */}
      <span aria-hidden="true" className="px-0.5 font-mono text-[11px] text-muted-foreground/40">
        …
      </span>
      <RefDropdown side="target" value={comparison?.target ?? null} refs={refs} onSelect={setBranchTarget} />
    </div>
  );
}
