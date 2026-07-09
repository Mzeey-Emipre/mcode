import { useState } from "react";
import { useSidebarSearchStore, type ThreadSortField } from "@/stores/sidebarSearchStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

const SORT_OPTIONS: { field: ThreadSortField; label: string }[] = [
  { field: "updated_at", label: "Recent activity" },
  { field: "created_at", label: "Created date" },
  { field: "title", label: "Name (A-Z)" },
];

const SORT_LABELS: Record<ThreadSortField, string> = {
  updated_at: "recent",
  created_at: "created",
  title: "name",
};

/** Direction label shown at the bottom of the sort dropdown. */
function directionLabel(field: ThreadSortField, dir: "asc" | "desc"): string {
  if (field === "title") return dir === "asc" ? "↑ A → Z" : "↓ Z → A";
  return dir === "desc" ? "↓ Newest first" : "↑ Oldest first";
}

/** Persistent sort label + dropdown for the sidebar PROJECTS header. */
export function ThreadSortControl() {
  const [open, setOpen] = useState(false);
  const sortField = useSidebarSearchStore((s) => s.sortField);
  const sortDirection = useSidebarSearchStore((s) => s.sortDirection);
  const setSortField = useSidebarSearchStore((s) => s.setSortField);
  const toggleSortDirection = useSidebarSearchStore((s) => s.toggleSortDirection);

  const arrow = sortDirection === "asc" ? "↑" : "↓";
  const isNonDefault = sortField !== "updated_at" || sortDirection !== "desc";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={isNonDefault ? "h-7 gap-1 px-2 text-xs text-primary" : "h-7 gap-1 px-2 text-xs text-muted-foreground"}
            aria-label="Sort threads"
          >
            {SORT_LABELS[sortField]} {arrow}
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
          Sort threads by
        </div>
        {SORT_OPTIONS.map((opt) => (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            key={opt.field}
            className={`h-7 w-full justify-between px-2 text-xs font-normal ${
              sortField === opt.field ? "text-primary" : "text-muted-foreground"
            }`}
            onClick={() => {
              setSortField(opt.field);
              setOpen(false);
            }}
          >
            {opt.label}
            {sortField === opt.field && <Check size={11} className="text-primary" />}
          </Button>
        ))}
        <div className="mx-1 my-1 h-px bg-border/50" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-7 w-full justify-start gap-1.5 px-2 text-xs font-normal text-muted-foreground"
          onClick={toggleSortDirection}
        >
          {directionLabel(sortField, sortDirection)}
          <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
            click to flip
          </span>
        </Button>
      </PopoverContent>
    </Popover>
  );
}
