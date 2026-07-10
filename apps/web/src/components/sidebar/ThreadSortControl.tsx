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
  updated_at: "Recent",
  created_at: "Created",
  title: "Name",
};

/** Direction label shown at the bottom of the sort dropdown. */
function directionLabel(field: ThreadSortField, dir: "asc" | "desc"): string {
  if (field === "title") return dir === "asc" ? "↑ A → Z" : "↓ Z → A";
  return dir === "desc" ? "↓ Newest first" : "↑ Oldest first";
}

/** Persistent sort control shared by thread-list surfaces. */
export function ThreadSortControl({
  showLabel = false,
}: {
  showLabel?: boolean;
}) {
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
            className={
              isNonDefault
                ? "h-8 gap-1.5 px-2 text-primary"
                : "h-8 gap-1.5 px-2 text-muted-foreground"
            }
            aria-label={`Sort threads: ${SORT_LABELS[sortField]}, ${directionLabel(sortField, sortDirection)}`}
          >
            {showLabel && <span className="text-xs">Sort</span>}
            <span className="text-xs">
              {SORT_LABELS[sortField]} {arrow}
            </span>
          </Button>
        }
      />
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={4}
        className="w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
      >
        <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
          Sort threads by
        </div>
        {SORT_OPTIONS.map((opt) => (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            key={opt.field}
            className={`h-8 w-full justify-between px-2 text-sm font-normal ${
              sortField === opt.field ? "text-primary" : "text-muted-foreground"
            }`}
            onClick={() => {
              setSortField(opt.field);
              setOpen(false);
            }}
          >
            {opt.label}
            {sortField === opt.field && (
              <Check size={11} className="text-primary" />
            )}
          </Button>
        ))}
        <div className="mx-1 my-1 h-px bg-border/50" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-8 w-full justify-start gap-1.5 px-2 text-sm font-normal text-muted-foreground"
          onClick={toggleSortDirection}
        >
          {directionLabel(sortField, sortDirection)}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
