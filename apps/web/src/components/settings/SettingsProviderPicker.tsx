import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Check } from "lucide-react";
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

/** cmdk Item `value` must be non-empty; utility "Auto" uses an empty provider id. */
const EMPTY_PROVIDER_CMDK = "__mcode_provider_auto__";

/** One selectable provider row for {@link SettingsProviderPicker}. */
export interface SettingsProviderPickOption {
  value: string;
  label: string;
  disabled: boolean;
  icon?: ReactNode;
  title?: string;
}

interface SettingsProviderPickerProps {
  /** Current provider id (empty string allowed for utility "Auto" mode). */
  value: string;
  /** Called when the user commits a provider selection. */
  onChange: (providerId: string) => void;
  /** Ordered options (typically aligned with {@link MODEL_PROVIDERS}). */
  options: SettingsProviderPickOption[];
  /** Popover alignment relative to the trigger. */
  align?: "start" | "center" | "end";
  /** Placeholder for the search input. Defaults to a provider-oriented label. */
  searchPlaceholder?: string;
  /** Accessible name for the search input. Defaults to a provider-oriented label. */
  searchAriaLabel?: string;
  /** Optional test id on the trigger button. */
  "data-testid"?: string;
}

/** Wraps SVG provider marks so rows stay monochrome in settings (no brand tint). */
function NeutralProviderGlyph({ children }: { children: ReactNode }) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5"
      aria-hidden
    >
      {children}
    </span>
  );
}

/**
 * Settings provider combobox: searchable list only (no composer-style rail).
 * Icons use muted foreground so the panel stays visually quiet next to model pickers.
 */
export function SettingsProviderPicker({
  value,
  onChange,
  options,
  align = "end",
  searchPlaceholder = "Search providers…",
  searchAriaLabel = "Search providers",
  "data-testid": testId,
}: SettingsProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  const selected = useMemo(
    () =>
      options.find((o) => o.value === value && !o.disabled) ??
      options.find((o) => o.value === value),
    [options, value],
  );

  const filtered = useMemo(() => {
    const tokens = tokenizeSearch(query);
    return options.filter((o) => matchesAllTokens([o.label, o.value], tokens));
  }, [options, query]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={testId}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="h-8 min-w-[200px] max-w-[260px] justify-between gap-2 px-2.5 text-xs font-normal"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {selected?.icon != null && <NeutralProviderGlyph>{selected.icon}</NeutralProviderGlyph>}
              <span className="truncate text-left">{selected?.label ?? value}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        }
      />
      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={4}
        className="flex h-[min(340px,calc(100vh-10rem))] w-[min(92vw,320px)] flex-col overflow-hidden p-0 shadow-lg"
      >
        <Command shouldFilter={false} className="min-h-0 flex-1 rounded-lg border-0">
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
            aria-label={searchAriaLabel}
          />
          <CommandList className="max-h-none min-h-0 flex-1 overflow-y-auto">
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {filtered.map((opt) => (
                <CommandItem
                  key={opt.value || "__auto"}
                  value={opt.value === "" ? EMPTY_PROVIDER_CMDK : opt.value}
                  disabled={opt.disabled}
                  data-testid={`settings-provider-option-${opt.value || "auto"}`}
                  title={opt.title}
                  keywords={[opt.label, opt.value].filter(Boolean)}
                  onSelect={() => {
                    if (opt.disabled) return;
                    onChange(opt.value);
                    handleOpenChange(false);
                  }}
                  className="text-xs"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {opt.icon != null && <NeutralProviderGlyph>{opt.icon}</NeutralProviderGlyph>}
                    <span className="truncate">{opt.label}</span>
                  </span>
                  {value === opt.value && <Check className="size-3.5 shrink-0" aria-hidden />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
