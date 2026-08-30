import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown } from "lucide-react";
import type { BranchComparison, GitBranch } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";

/** The scope key a comparison is resolved against (`workspaceId:threadId`). */
function scopeKey(workspaceId: string, threadId?: string): string {
  return `${workspaceId}:${threadId ?? ""}`;
}

/**
 * Resolves the default Branch comparison for a scope (per ADR 0007) and seeds it
 * into the diff store as `current -> selected ref`. Re-resolves when the scope
 * changes; preserves a user's picked target when the active comparison was
 * already resolved for this scope (so toggling views within a scope keeps the
 * chosen target). Returns the
 * current comparison plus whether the initial resolve is in flight.
 */
function useResolveBranchComparison(
  workspaceId: string,
  threadId: string | undefined,
  diffScopeRevision: number,
): { comparison: BranchComparison | null; loading: boolean } {
  const comparison = useDiffStore((s) => s.branchComparison);
  const resolveBranchComparison = useDiffStore((s) => s.resolveBranchComparison);
  const [loading, setLoading] = useState(false);
  const key = scopeKey(workspaceId, threadId);

  useEffect(() => {
    const state = useDiffStore.getState();
    // The "already resolved for this scope+revision" guard is store-backed (not a
    // component ref) so it survives a remount and skips a redundant re-fetch.
    if (
      state.branchComparisonKey === key &&
      state.branchComparison &&
      state.branchResolvedRevisionByScope[key] === diffScopeRevision
    ) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void getTransport()
      .getBranchComparison(workspaceId, threadId)
      .then((result) => {
        if (cancelled) return;
        resolveBranchComparison(normalizeToCurrentComparison(result), key, diffScopeRevision);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        resolveBranchComparison(
          { base: null, target: null, refs: [], isUnborn: false, isComparisonAvailable: false },
          key,
          diffScopeRevision,
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, threadId, diffScopeRevision, resolveBranchComparison]);

  return { comparison, loading };
}

/**
 * Adapt the server's semantic default (`base...current` for feature branches)
 * into the toolbar model the user sees: current branch fixed on the left, one
 * selectable comparison ref on the right.
 */
function normalizeToCurrentComparison(comparison: BranchComparison): BranchComparison {
  if (comparison.isUnborn) return comparison;

  const current = comparison.refs.find((ref) => ref.isCurrent)?.name ?? (
    comparison.target === "HEAD" ? "HEAD" : null
  );
  if (!current) return comparison;

  const selected =
    comparison.base === null
      ? null
      : comparison.base === current
        ? comparison.target
        : comparison.base;

  return { ...comparison, base: current, target: selected };
}

/** Refs bucketed for the picker's group sections, in render order. */
interface RefGroups {
  worktree: GitBranch[];
  local: GitBranch[];
  remote: GitBranch[];
}

/** Bucket the flat ref list into the picker's three sections. */
function groupRefs(refs: readonly GitBranch[]): RefGroups {
  const groups: RefGroups = { worktree: [], local: [], remote: [] };
  for (const ref of refs) groups[ref.type].push(ref);
  return groups;
}

/** Section order + headings for the grouped ref menu. */
const REF_SECTIONS: ReadonlyArray<{ type: GitBranch["type"]; heading: string }> = [
  { type: "worktree", heading: "Worktrees" },
  { type: "local", heading: "Local" },
  { type: "remote", heading: "Remotes" },
];

/**
 * Truncate a long ref name in the middle rather than at the tail. Branch names
 * put the distinctive part last (`…/docstrings/2bbc811`), so tail-ellipsis makes
 * long siblings identical; keeping both ends tells them apart at a glance.
 */
function middleTruncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const tail = 12;
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}

/**
 * A ref name with its remote prefix de-emphasized. Every row in the Remotes
 * section starts with the same `origin/`; muting it makes the distinctive rest
 * carry the row. Long names middle-truncate so sibling refs stay tellable apart.
 */
function RefName({
  name,
  type,
  active,
}: {
  name: string;
  type: GitBranch["type"];
  active: boolean;
}) {
  const slash = type === "remote" ? name.indexOf("/") : -1;
  const prefix = slash >= 0 ? name.slice(0, slash + 1) : null;
  const rest = slash >= 0 ? name.slice(slash + 1) : name;
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[11px]",
        active ? "text-foreground" : "text-foreground/80",
      )}
      title={name}
    >
      {prefix && <span className="text-muted-foreground/50">{prefix}</span>}
      {middleTruncate(rest, prefix ? 22 : 29)}
    </span>
  );
}

/**
 * The selected comparison ref: a quiet toolbar chip that opens a searchable,
 * grouped ref combobox. Ref rows follow the Commit picker rhythm: primary ref
 * name, quiet metadata, and a check for the active selection.
 */
function RefCombobox({
  value,
  refs,
  onSelect,
}: {
  value: string | null;
  refs: readonly GitBranch[];
  onSelect: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupRefs(refs), [refs]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="branch-target-picker"
            aria-label="Select comparison ref"
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "h-6 min-w-0 max-w-[164px] flex-1 shrink justify-between gap-1.5 rounded-md px-2 font-mono text-xs font-medium",
              "text-foreground shadow-none hover:bg-foreground/[0.06] aria-expanded:bg-foreground/[0.06]",
            )}
          >
            <span className={cn("min-w-0 truncate", !value && "text-muted-foreground")}>
              {value ?? "select ref"}
            </span>
            <ChevronDown size={11} className="shrink-0 text-muted-foreground/65" />
          </Button>
        }
      >
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={4} className="w-80 p-0">
        <Command>
          <CommandInput
            placeholder="Search refs..."
            className="h-8 text-[11.5px]"
            data-testid="branch-target-filter"
          />
          <CommandList>
            <CommandEmpty className="py-4 text-[11px]">No refs found</CommandEmpty>

            {REF_SECTIONS.map(({ type, heading }) => {
              const sectionRefs = groups[type];
              if (sectionRefs.length === 0) return null;
              return (
                <CommandGroup key={type} heading={heading}>
                  {sectionRefs.map((ref) => {
                    const active = ref.name === value;
                    return (
                      <CommandItem
                        key={ref.name}
                        value={ref.name}
                        onSelect={() => {
                          onSelect(ref.name);
                          setOpen(false);
                        }}
                        data-testid={`branch-ref-target-${ref.name}`}
                        aria-current={active ? "true" : undefined}
                        className="gap-2 px-2 py-1.5"
                      >
                        <RefName name={ref.name} type={ref.type} active={active} />
                        {active ? (
                          <Check size={11} className="shrink-0 text-muted-foreground" />
                        ) : (
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/45">
                            {ref.shortSha}
                          </span>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Read-only chip for the current branch on the left side of the comparison. */
function CurrentRefChip({ value }: { value: string | null }) {
  return (
    <span
      data-testid="branch-current-ref"
      aria-label={`Current branch: ${value ?? "unknown"}`}
      title={value ?? "Current branch"}
      className={cn(
        "flex h-6 min-w-0 shrink items-center rounded-md px-2 font-mono text-xs font-medium",
        "text-muted-foreground",
      )}
    >
      <span className={cn("max-w-[142px] truncate", !value && "text-muted-foreground")}>
        {value ?? "current"}
      </span>
    </span>
  );
}

/** Props for {@link BranchRefPicker}. */
interface BranchRefPickerProps {
  /** Active workspace id (the repo whose refs populate the pickers). */
  workspaceId: string;
  /** Active thread id; makes "current branch" the thread's worktree branch. */
  threadId?: string;
  /** Bumps when git state changes in this scope; triggers comparison re-resolution. */
  diffScopeRevision: number;
}

function BranchRefPickerPlaceholder({ children }: { children: string }) {
  return <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/40">{children}</span>;
}

function BranchRefPickerContent({ comparison, onSelect }: { comparison: BranchComparison | null; onSelect: (target: string) => void }) {
  const refs = comparison?.refs ?? [];
  return <div className="flex min-w-0 max-w-[min(46vw,390px)] items-center gap-1 overflow-hidden" data-testid="branch-ref-picker" role="group" aria-label="Branch comparison range">
    <CurrentRefChip value={comparison?.base ?? null} />
    <div className="flex min-w-0 flex-1 items-center gap-0.5 border-l border-border/25 pl-1">
      <span aria-hidden="true" data-testid="branch-range-arrow" className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/50"><ArrowRight size={12} strokeWidth={1.8} /></span>
      <RefCombobox value={comparison?.target ?? null} refs={refs} onSelect={onSelect} />
    </div>
  </div>;
}

/**
 * The Branch view's operand control: a read-only current-branch chip on the left
 * and one selected comparison ref on the right. The stored pair is always
 * `current...selected`, and the right side is the only picker.
 */
export function BranchRefPicker({
  workspaceId,
  threadId,
  diffScopeRevision,
}: BranchRefPickerProps) {
  const { comparison, loading } = useResolveBranchComparison(
    workspaceId,
    threadId,
    diffScopeRevision,
  );
  const setBranchTarget = useDiffStore((s) => s.setBranchTarget);

  if (loading && !comparison) {
    return <BranchRefPickerPlaceholder>Resolving</BranchRefPickerPlaceholder>;
  }
  if (comparison?.isUnborn) {
    return <BranchRefPickerPlaceholder>No commits yet</BranchRefPickerPlaceholder>;
  }
  return <BranchRefPickerContent comparison={comparison} onSelect={setBranchTarget} />;
}
