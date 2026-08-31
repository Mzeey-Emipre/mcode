import { useMemo, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { tokenizeSearch, matchesAllTokens } from "@/lib/searchTokens";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** cmdk Item `value` must be non-empty; map "" to this sentinel internally. */
const EMPTY_OPTION_CMDK = "__mcode_empty_option__";

/** One selectable row for {@link SearchableGroupedPicker}. */
export interface GroupedPickOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

interface SearchableGroupedPickerProps {
  /** Current selection id (empty string allowed). */
  value: string;
  /** Called when the user picks an option. */
  onChange: (next: string) => void;
  /** Full option list (typically catalog plus stale saved rows). */
  options: GroupedPickOption[];
  /** Text on the closed trigger when there is no matching label. */
  emptyTriggerLabel?: string;
  /** Placeholder for the search field inside the popover. */
  searchPlaceholder?: string;
  /** Disables opening the picker. */
  disabled?: boolean;
  /** Shows a spinner-style hint on the trigger while models load. */
  loading?: boolean;
  /** Optional anchor alignment for the popover. */
  align?: "start" | "center" | "end";
  /** Optional test id on the trigger button. */
  "data-testid"?: string;
}

/**
 * Settings-friendly combobox: popover with multi-token search and optional group headings.
 * Matches composer model search semantics via {@link tokenizeSearch}.
 */
export function SearchableGroupedPicker({
  value,
  onChange,
  options,
  emptyTriggerLabel = "Choose…",
  searchPlaceholder = "Search…",
  disabled,
  loading,
  align = "end",
  "data-testid": testId,
}: SearchableGroupedPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  const selectedLabel = useMemo(() => {
    const row = options.find((o) => o.value === value && !o.disabled);
    return row?.label ?? (value ? value : emptyTriggerLabel);
  }, [options, value, emptyTriggerLabel]);

  const filtered = useMemo(() => {
    const tokens = tokenizeSearch(query);
    return options.filter((o) => matchesAllTokens([o.label, o.value, o.group ?? ""], tokens));
  }, [options, query]);

  const groupedSections = useMemo(() => {
    const hasHeading = filtered.some((o) => Boolean(o.group?.trim()));
    if (!hasHeading) {
      return [{ heading: undefined as string | undefined, items: filtered }];
    }
    const map = new Map<string, GroupedPickOption[]>();
    for (const o of filtered) {
      const g = o.group?.trim() ?? "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(o);
    }
    return Array.from(map.entries()).map(([heading, items]) => ({
      heading: heading || undefined,
      items,
    }));
  }, [filtered]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || loading}
            data-testid={testId}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "min-w-[220px] max-w-[280px] justify-between font-normal",
              (disabled || loading) && "opacity-60",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-left">{loading ? "Loading…" : selectedLabel}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        }
      />
      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={4}
        className="flex h-[min(320px,calc(100vh-10rem))] w-[min(92vw,320px)] flex-col overflow-hidden p-0 shadow-lg"
      >
        <Command shouldFilter={false} className="min-h-0 flex-1 rounded-lg border-0">
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
            aria-label={searchPlaceholder}
          />
          <CommandList className="max-h-none min-h-0 flex-1 overflow-y-auto">
            <CommandEmpty>No matches.</CommandEmpty>
            {groupedSections.map((section) => (
              <CommandGroup
                key={section.heading ?? "__flat"}
                {...(section.heading ? { heading: section.heading } : {})}
              >
                {section.items.map((o) => (
                  <CommandItem
                    key={`${section.heading ?? ""}:${o.label}:${o.value || EMPTY_OPTION_CMDK}`}
                    value={o.value === "" ? EMPTY_OPTION_CMDK : o.value}
                    disabled={o.disabled}
                    keywords={[o.label, o.value, o.group ?? ""].filter(Boolean)}
                    onSelect={() => {
                      if (o.disabled) return;
                      onChange(o.value);
                      handleOpenChange(false);
                    }}
                    className="text-xs"
                  >
                    <span className="flex-1 truncate">{o.label}</span>
                    {value === o.value && <Check className="size-3.5 shrink-0" aria-hidden />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
