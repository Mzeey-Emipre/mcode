import { useRef, useEffect } from "react";
import { useSidebarSearchStore } from "@/stores/sidebarSearchStore";
import { ThreadFilterDropdown } from "./ThreadFilterDropdown";
import { ThreadSortControl } from "./ThreadSortControl";
import { Search, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

/** Dismissible filter chip. */
function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="animate-chip-enter inline-flex items-center gap-1 rounded border border-primary/25 bg-primary/8 px-1.5 py-px font-mono text-[9px] tracking-[0.04em] text-primary/60">
      {label}
      <button
        className="cursor-pointer p-1 -m-0.5 text-primary/40 transition-colors hover:text-primary/60 focus-visible:ring-1 focus-visible:ring-primary/40"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
      >
        <X size={8} />
      </button>
    </span>
  );
}

/** Inset tray search input with filter icon and dismissible chip row. */
export function ThreadSearchBar({ providers }: { providers: string[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useSidebarSearchStore((s) => s.query);
  const setQuery = useSidebarSearchStore((s) => s.setQuery);
  const clearQuery = useSidebarSearchStore((s) => s.clearQuery);
  const isSearching = useSidebarSearchStore((s) => s.isSearching);
  const searchError = useSidebarSearchStore((s) => s.searchError);
  const filters = useSidebarSearchStore((s) => s.filters);
  const toggleFilter = useSidebarSearchStore((s) => s.toggleFilter);
  const clearFilters = useSidebarSearchStore((s) => s.clearFilters);

  const hasFilters = filters.status.length > 0 || filters.provider.length > 0;

  // Ctrl+Shift+F / Cmd+Shift+F focuses the search input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (query) {
        setQuery("");
      } else {
        inputRef.current?.blur();
      }
    }
  };

  return (
    <div className="px-1.5 pb-0.5 pt-1.5">
      <div className="relative">
        <Search
          size={12}
          className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 transition-colors ${
            query ? "text-primary/50" : "text-muted-foreground/35"
          }`}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search threads..."
          className="w-full rounded-[5px] border border-sidebar-border/40 bg-white/[0.06] py-[5px] pl-7 pr-16 text-[11px] text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)] outline-none transition-[box-shadow,border-color] duration-150 ease-out placeholder:text-muted-foreground/40 focus-visible:border-primary/30 focus-visible:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] focus-visible:ring-1 focus-visible:ring-primary/35"
          data-testid="sidebar-search-input"
        />
        {isSearching && (
          <Spinner size={10} className="absolute right-8 top-1/2 -translate-y-1/2 text-muted-foreground/45" />
        )}
        {query && !isSearching && (
          <button
            className="absolute right-8 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-primary/40"
            onClick={clearQuery}
            aria-label="Clear search"
          >
            <X size={10} />
          </button>
        )}
        <ThreadFilterDropdown providers={providers} />
      </div>

      {searchError && (
        <div role="status" aria-live="polite" className="mt-1 px-0.5 text-[9px] text-destructive/60">
          Search unavailable
        </div>
      )}

      {/* Sort + filter controls row */}
      <div className="mt-1 flex items-center justify-between px-0.5">
        <ThreadSortControl />
        {hasFilters && (
          <button
            className="cursor-pointer font-mono text-[9px] tracking-[0.06em] text-muted-foreground/45 transition-colors hover:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-primary/40"
            onClick={clearFilters}
          >
            clear filters
          </button>
        )}
      </div>

      {hasFilters && (
        <div className="mt-1 flex flex-wrap items-center gap-1 px-0.5" data-testid="filter-chip-row">
          {filters.status.map((s) => (
            <FilterChip key={s} label={s} onRemove={() => toggleFilter("status", s)} />
          ))}
          {filters.provider.map((p) => (
            <FilterChip key={p} label={p} onRemove={() => toggleFilter("provider", p)} />
          ))}
        </div>
      )}
    </div>
  );
}
