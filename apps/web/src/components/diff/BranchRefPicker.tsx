import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { BranchComparison, GitBranch } from "@mcode/contracts";
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
        "flex-1 truncate whitespace-nowrap",
        active ? "text-foreground" : "text-popover-foreground",
      )}
      title={name}
    >
      {prefix && <span className="text-muted-foreground/50">{prefix}</span>}
      {middleTruncate(rest, prefix ? 22 : 29)}
    </span>
  );
}

/**
 * One side (base or target) of the comparison: a quiet toolbar chip that opens a
 * searchable, grouped ref combobox. Machine facts (ref names, SHAs) are mono;
 * the current branch carries the amber dot; selection is a row-fill + check.
 */
function RefCombobox({
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
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupRefs(refs), [refs]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid={`branch-${side}-picker`}
        aria-label={`Select ${side} ref`}
        className={cn(
          "flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] font-medium",
          "bg-muted/60 text-foreground transition-colors hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <span className={cn("max-w-[132px] truncate", !value && "text-muted-foreground")}>
          {value ?? "select ref"}
        </span>
        <ChevronDown size={11} className="shrink-0 text-muted-foreground/60" />
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={6} className="w-[320px] p-0">
        <Command>
          <CommandInput
            placeholder="Filter refs"
            className="h-8 py-2 font-mono text-xs"
            data-testid={`branch-${side}-filter`}
          />
          <CommandList className="max-h-[296px]">
            <CommandEmpty>
              <div className="flex flex-col items-center gap-2 py-4">
                <span aria-hidden="true" className="font-mono text-xl leading-none text-muted-foreground/15">
                  ⊘
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/40">
                  No matching refs
                </span>
              </div>
            </CommandEmpty>

            {REF_SECTIONS.map(({ type, heading }) => {
              const sectionRefs = groups[type];
              if (sectionRefs.length === 0) return null;
              return (
                <CommandGroup
                  key={type}
                  heading={heading}
                  className="[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[9.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.18em] [&_[cmdk-group-heading]]:text-muted-foreground/50"
                >
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
                        data-testid={`branch-ref-${side}-${ref.name}`}
                        aria-current={active ? "true" : undefined}
                        className="gap-2 py-1 font-mono text-xs"
                      >
                        {/* The amber dot marks the checked-out branch — the same
                            glance vocabulary as the sidebar's status dots. */}
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            ref.isCurrent ? "bg-primary" : "bg-transparent",
                          )}
                        />
                        <RefName name={ref.name} type={ref.type} active={active} />
                        {active ? (
                          <Check size={11} className="shrink-0 text-muted-foreground" />
                        ) : (
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/40">
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

/** Props for {@link BranchRefPicker}. */
interface BranchRefPickerProps {
  /** Active workspace id (the repo whose refs populate the pickers). */
  workspaceId: string;
  /** Active thread id; makes "current branch" the thread's worktree branch. */
  threadId?: string;
}

/**
 * The Branch view's operand control: two ref comboboxes (`base … target`) the
 * user picks independently, always diffed three-dot. Renders into the Review
 * toolbar's contextual operand slot. Resolves its default pair per ADR 0007 and
 * writes the chosen pair to the diff store, which drives the rendered Branch diff.
 */
export function BranchRefPicker({ workspaceId, threadId }: BranchRefPickerProps) {
  const { comparison, loading } = useResolveBranchComparison(workspaceId, threadId);
  const setBranchBase = useDiffStore((s) => s.setBranchBase);
  const setBranchTarget = useDiffStore((s) => s.setBranchTarget);

  if (loading && !comparison) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/40">
        Resolving
      </span>
    );
  }
  if (comparison?.isUnborn) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/40">
        No commits yet
      </span>
    );
  }

  const refs = comparison?.refs ?? [];
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid="branch-ref-picker">
      <RefCombobox side="base" value={comparison?.base ?? null} refs={refs} onSelect={setBranchBase} />
      {/* Three-dot range indicator (always `base...target`, never two-dot). */}
      <span aria-hidden="true" className="font-mono text-[11px] leading-none text-muted-foreground/40">
        …
      </span>
      <RefCombobox side="target" value={comparison?.target ?? null} refs={refs} onSelect={setBranchTarget} />
    </div>
  );
}
