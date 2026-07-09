import { useState } from "react";
import { useSidebarSearchStore } from "@/stores/sidebarSearchStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Check, ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "errored", label: "Errored" },
  { value: "interrupted", label: "Interrupted" },
  { value: "paused", label: "Paused" },
  { value: "action_required", label: "Action required" },
];

/** Checkbox row inside the filter dropdown. */
function FilterCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      role="checkbox"
      aria-checked={checked}
      className="h-7 w-full justify-start gap-2 px-2 text-xs font-normal text-muted-foreground"
      onClick={onChange}
    >
      <span
        className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border text-[8px] ${
          checked
            ? "border-primary/40 bg-primary/20 text-primary"
            : "border-border"
        }`}
      >
        {checked && <Check size={8} strokeWidth={3} />}
      </span>
      {label}
    </Button>
  );
}

/** Filter popover triggered from the search bar's filter icon. */
export function ThreadFilterDropdown({ providers }: { providers: string[] }) {
  const [open, setOpen] = useState(false);
  const filters = useSidebarSearchStore((s) => s.filters);
  const toggleFilter = useSidebarSearchStore((s) => s.toggleFilter);
  const clearFilters = useSidebarSearchStore((s) => s.clearFilters);

  const hasActiveFilters = filters.status.length > 0 || filters.provider.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              "text-muted-foreground",
              hasActiveFilters ? "bg-primary/10 text-primary" : "hover:text-foreground",
            )}
            aria-label="Filter threads"
          >
            <ListFilter size={12} />
          </Button>
        }
      />
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={4}
        className="w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
      >
        <div className="px-2 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
          Status
        </div>
        {STATUS_OPTIONS.map((opt) => (
          <FilterCheckbox
            key={opt.value}
            label={opt.label}
            checked={filters.status.includes(opt.value)}
            onChange={() => toggleFilter("status", opt.value)}
          />
        ))}
        {providers.length > 0 && (
          <>
            <div className="mx-1 my-1 h-px bg-border/50" />
            <div className="px-2 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
              Provider
            </div>
            {providers.map((p) => (
              <FilterCheckbox
                key={p}
                label={p}
                checked={filters.provider.includes(p)}
                onChange={() => toggleFilter("provider", p)}
              />
            ))}
          </>
        )}
        {hasActiveFilters && (
          <>
            <div className="mx-1 my-1 h-px bg-border/50" />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 w-full justify-start px-2 text-xs font-normal text-muted-foreground"
              onClick={() => {
                clearFilters();
                setOpen(false);
              }}
            >
              Clear all
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
