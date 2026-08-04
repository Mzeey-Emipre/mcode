import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { Terminal } from "@xterm/xterm";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  cycleTerminalSearchVariant,
  TERMINAL_SEARCH_VARIANT_EVENT,
} from "./terminalSearchGate";
import type { TerminalSearchVariant } from "./terminalSearchGate";

export { cycleTerminalSearchVariant, getTerminalSearchVariant } from "./terminalSearchGate";
export type { TerminalSearchVariant } from "./terminalSearchGate";

type TerminalSearchOptions = Pick<
  ISearchOptions,
  "caseSensitive" | "wholeWord" | "regex"
>;

type TerminalSearchPersistedState = {
  readonly open: boolean;
  readonly query: string;
  readonly options: TerminalSearchOptions;
};

type TerminalSearchResult = {
  readonly resultIndex: number;
  readonly resultCount: number;
};

const DEFAULT_SEARCH_OPTIONS: TerminalSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

const MAX_TERMINAL_SEARCH_STATES = 32;
const terminalSearchStateByPtyId = new Map<string, TerminalSearchPersistedState>();

function readTerminalSearchState(ptyId: string): TerminalSearchPersistedState {
  const persisted = terminalSearchStateByPtyId.get(ptyId);
  if (!persisted) {
    return { open: false, query: "", options: { ...DEFAULT_SEARCH_OPTIONS } };
  }
  terminalSearchStateByPtyId.delete(ptyId);
  terminalSearchStateByPtyId.set(ptyId, persisted);
  return {
    open: persisted.open,
    query: persisted.query,
    options: { ...persisted.options },
  };
}

function writeTerminalSearchState(
  ptyId: string,
  state: TerminalSearchPersistedState,
): void {
  terminalSearchStateByPtyId.delete(ptyId);
  terminalSearchStateByPtyId.set(ptyId, state);
  while (terminalSearchStateByPtyId.size > MAX_TERMINAL_SEARCH_STATES) {
    const oldest = terminalSearchStateByPtyId.keys().next().value;
    if (typeof oldest !== "string") break;
    terminalSearchStateByPtyId.delete(oldest);
  }
}

const EMPTY_RESULT: TerminalSearchResult = {
  resultIndex: -1,
  resultCount: 0,
};

const SEARCH_DECORATIONS = {
  matchBackground: "#3f3f46",
  matchBorder: "#a1a1aa",
  matchOverviewRuler: "#f59e0b",
  activeMatchBackground: "#b45309",
  activeMatchBorder: "#fbbf24",
  activeMatchColorOverviewRuler: "#fbbf24",
} as const;

/** Maximum query length accepted by the gated terminal search prototype. */
export const TERMINAL_SEARCH_QUERY_MAX_LENGTH = 256;

/** Compiles a search expression with the requested case-sensitivity flag. */
export function compileTerminalSearchRegex(
  query: string,
  caseSensitive: boolean,
): RegExp | null {
  try {
    return new RegExp(query, caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}

function formatSearchFailure(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Search failed: ${error.message}`;
  }
  return "Search failed";
}

function replaceVariantInUrl(variant: TerminalSearchVariant): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("terminalSearchVariant", variant);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(
    new CustomEvent<TerminalSearchVariant>(TERMINAL_SEARCH_VARIANT_EVENT, {
      detail: variant,
    }),
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "input, textarea, [contenteditable='true'], [contenteditable='plaintext-only'], .xterm-helper-textarea",
    ),
  );
}

type TerminalSearchSwitcherProps = {
  readonly variant: TerminalSearchVariant;
  readonly onVariantChange: (variant: TerminalSearchVariant) => void;
};

/** Fixed development-only control for cycling the three prototype presentations. */
export function TerminalSearchPrototypeSwitcher({
  variant,
  onVariantChange,
}: TerminalSearchSwitcherProps) {
  const changeVariant = useCallback(
    (next: TerminalSearchVariant) => {
      replaceVariantInUrl(next);
      onVariantChange(next);
    },
    [onVariantChange],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      changeVariant(
        cycleTerminalSearchVariant(
          variant,
          event.key === "ArrowRight" ? "next" : "previous",
        ),
      );
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [changeVariant, variant]);

  return (
    <div
      className={cn(
        "pointer-events-auto fixed inset-x-0 z-50 flex justify-center px-3",
        variant === "shelf" ? "bottom-24" : "bottom-3",
      )}
      data-testid="terminal-search-variant-switcher"
      data-terminal-search-variant={variant}
    >
      <div className="flex items-center gap-1 rounded-lg border border-border bg-popover px-1 py-1 text-xs text-muted-foreground shadow-md">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Previous terminal search presentation"
                onClick={() =>
                  changeVariant(cycleTerminalSearchVariant(variant, "previous"))
                }
              />
            }
          >
            <ChevronLeft aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Previous presentation
          </TooltipContent>
        </Tooltip>
        <Badge variant="secondary" className="min-w-16 justify-center capitalize">
          {variant}
        </Badge>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Next terminal search presentation"
                onClick={() =>
                  changeVariant(cycleTerminalSearchVariant(variant, "next"))
                }
              />
            }
          >
            <ChevronRight aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Next presentation
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function SearchOptionCheckbox({
  label,
  checked,
  onCheckedChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-foreground hover:bg-muted/60">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-label={label}
      />
      <span>{label}</span>
    </label>
  );
}

function SearchOptions({
  options,
  onChange,
  className,
}: {
  readonly options: TerminalSearchOptions;
  readonly onChange: (key: keyof TerminalSearchOptions, checked: boolean) => void;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <SearchOptionCheckbox
        label="Case sensitive"
        checked={options.caseSensitive ?? false}
        onCheckedChange={(checked) => onChange("caseSensitive", checked)}
      />
      <SearchOptionCheckbox
        label="Whole word"
        checked={options.wholeWord ?? false}
        onCheckedChange={(checked) => onChange("wholeWord", checked)}
      />
      <SearchOptionCheckbox
        label="Regular expression"
        checked={options.regex ?? false}
        onCheckedChange={(checked) => onChange("regex", checked)}
      />
    </div>
  );
}

function SearchOptionsPopover({
  options,
  onChange,
}: {
  readonly options: TerminalSearchOptions;
  readonly onChange: (key: keyof TerminalSearchOptions, checked: boolean) => void;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                aria-label="Terminal search options"
                data-testid="terminal-search-options-trigger"
              >
                <SlidersHorizontal aria-hidden />
              </Button>
            }
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Search options
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={6} className="w-64 p-2">
        <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">
          Search options
        </div>
        <SearchOptions
          options={options}
          onChange={onChange}
          className="flex-col items-stretch gap-0"
        />
      </PopoverContent>
    </Popover>
  );
}

function TooltipIconButton({
  label,
  description,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function SearchMatchStatus({
  result,
  invalidRegex,
  searchError,
  hasQuery,
  quiet,
}: {
  readonly result: TerminalSearchResult;
  readonly invalidRegex: boolean;
  readonly searchError: string | null;
  readonly hasQuery: boolean;
  readonly quiet: boolean;
}) {
  const quietStatusClassName = cn(
    "min-w-20 shrink-0 whitespace-nowrap text-xs tabular-nums",
    invalidRegex || searchError ? "text-destructive" : "text-muted-foreground",
  );
  const emptyQuietStatus = quiet && !hasQuery && !invalidRegex && !searchError;

  return (
    <span
      className={quiet ? quietStatusClassName : "shrink-0"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {emptyQuietStatus ? null : quiet ? (
        invalidRegex ? (
          "Invalid regular expression"
        ) : searchError ? (
          searchError
        ) : result.resultCount === 0 ? (
          "No matches"
        ) : result.resultIndex >= 0 ? (
          `${result.resultIndex + 1} / ${result.resultCount}`
        ) : (
          `${result.resultCount} matches`
        )
      ) : invalidRegex ? (
        <Badge variant="destructive">Invalid regular expression</Badge>
      ) : searchError ? (
        <Badge variant="destructive">{searchError}</Badge>
      ) : result.resultCount === 0 ? (
        <Badge variant="outline">No matches</Badge>
      ) : (
        <Badge
          variant="secondary"
          aria-label={`${result.resultCount} matches`}
        >
          {result.resultIndex >= 0
            ? `${result.resultIndex + 1} / ${result.resultCount}`
            : `${result.resultCount} matches`}
        </Badge>
      )}
    </span>
  );
}

type FindControlsProps = {
  readonly query: string;
  readonly inputRef: MutableRefObject<HTMLInputElement | null>;
  readonly options: TerminalSearchOptions;
  readonly result: TerminalSearchResult;
  readonly invalidRegex: boolean;
  readonly searchError: string | null;
  readonly addonReady: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onOptionChange: (key: keyof TerminalSearchOptions, checked: boolean) => void;
  readonly onNavigate: (direction: "next" | "previous") => void;
  readonly onClose: () => void;
  readonly variant: TerminalSearchVariant;
};

function FindControls({
  query,
  inputRef,
  options,
  result,
  invalidRegex,
  searchError,
  addonReady,
  onQueryChange,
  onOptionChange,
  onNavigate,
  onClose,
  variant,
}: FindControlsProps) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && !invalidRegex && addonReady && query) {
      event.preventDefault();
      onNavigate(event.shiftKey ? "previous" : "next");
    }
  };

  const navigationDisabled =
    invalidRegex || searchError !== null || !addonReady || !query || result.resultCount === 0;
  const fullOptions = variant === "lane";
  const navigationControls = (
    <>
      <TooltipIconButton
        label="Previous terminal match"
        description="Previous match (Shift+Enter)"
        disabled={navigationDisabled}
        onClick={() => onNavigate("previous")}
      >
        <ChevronUp aria-hidden />
      </TooltipIconButton>
      <TooltipIconButton
        label="Next terminal match"
        description="Next match (Enter)"
        disabled={navigationDisabled}
        onClick={() => onNavigate("next")}
      >
        <ChevronDown aria-hidden />
      </TooltipIconButton>
    </>
  );
  const optionsControl = fullOptions ? (
    <SearchOptions
      options={options}
      onChange={onOptionChange}
      className="min-w-0 flex-wrap gap-0"
    />
  ) : (
    <SearchOptionsPopover options={options} onChange={onOptionChange} />
  );

  return (
    <div
      className="grid min-w-0 gap-1.5"
      data-testid="terminal-search-controls"
    >
      <div
        className="flex min-w-0 items-center gap-1.5"
        data-testid="terminal-search-primary-row"
      >
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in terminal"
          aria-label="Find in terminal"
          aria-invalid={invalidRegex || searchError !== null}
          maxLength={TERMINAL_SEARCH_QUERY_MAX_LENGTH}
          className="min-w-0 flex-1 truncate whitespace-nowrap"
          size="sm"
        />
        <TooltipIconButton
          label="Close terminal search"
          description="Close (Esc)"
          onClick={onClose}
        >
          <X aria-hidden />
        </TooltipIconButton>
      </div>
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          fullOptions && "flex-wrap",
          variant === "shelf" && "justify-between",
        )}
        data-testid="terminal-search-secondary-row"
      >
        <SearchMatchStatus
          result={result}
          invalidRegex={invalidRegex}
          searchError={searchError}
          hasQuery={query.length > 0}
          quiet={variant === "shelf"}
        />
        {variant === "shelf" ? (
          <div
            className="ml-auto flex shrink-0 items-center gap-0.5"
            data-testid="terminal-search-actions"
          >
            {navigationControls}
            {optionsControl}
          </div>
        ) : (
          <>
            {navigationControls}
            {optionsControl}
          </>
        )}
      </div>
    </div>
  );
}

type TerminalSearchPrototypeProps = {
  readonly ptyId: string;
  readonly active: boolean;
  readonly variant: TerminalSearchVariant;
  readonly terminal: Terminal | null;
  readonly searchAddon: SearchAddon | null;
  readonly shortcutRef: MutableRefObject<(() => void) | null>;
  readonly onVariantChange: (variant: TerminalSearchVariant) => void;
  readonly showSwitcher: boolean;
};

/** Renders the gated terminal search prototype over a real xterm terminal. */
export function TerminalSearchPrototype({
  ptyId,
  active,
  variant,
  terminal,
  searchAddon,
  shortcutRef,
  onVariantChange,
  showSwitcher,
}: TerminalSearchPrototypeProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const addonRef = useRef<SearchAddon | null>(searchAddon);
  addonRef.current = searchAddon;
  const [searchState, setSearchState] = useState<TerminalSearchPersistedState>(() =>
    readTerminalSearchState(ptyId),
  );
  const { open, query, options } = searchState;
  const [result, setResult] = useState<TerminalSearchResult>(EMPTY_RESULT);
  const [invalidRegex, setInvalidRegex] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const updateSearchState = useCallback(
    (update: Partial<TerminalSearchPersistedState>) => {
      setSearchState((current) => {
        const next = { ...current, ...update };
        writeTerminalSearchState(ptyId, next);
        return next;
      });
    },
    [ptyId],
  );

  useEffect(() => {
    setSearchState(readTerminalSearchState(ptyId));
    setResult(EMPTY_RESULT);
    setInvalidRegex(false);
    setSearchError(null);
  }, [ptyId]);

  const focusQuery = useCallback(() => {
    if (!active) return;
    updateSearchState({ open: true });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [active, updateSearchState]);

  useEffect(() => {
    shortcutRef.current = active ? focusQuery : null;
    return () => {
      if (shortcutRef.current === focusQuery) shortcutRef.current = null;
    };
  }, [active, focusQuery, shortcutRef]);

  useEffect(() => {
    setResult(EMPTY_RESULT);
    if (!active || !searchAddon) return;
    const resultDisposable = searchAddon.onDidChangeResults((next) => {
      setResult({ resultIndex: next.resultIndex, resultCount: next.resultCount });
    });
    return () => resultDisposable.dispose();
  }, [active, searchAddon]);

  const searchOptions = useMemo<ISearchOptions>(
    () => ({
      ...options,
      incremental: true,
      decorations: SEARCH_DECORATIONS,
    }),
    [options],
  );

  const clearSearchDecorations = useCallback(() => {
    addonRef.current?.clearDecorations();
    terminal?.clearSelection();
    setResult(EMPTY_RESULT);
    setInvalidRegex(false);
    setSearchError(null);
  }, [terminal]);

  const runSearch = useCallback(
    (direction: "next" | "previous") => {
      const addon = searchAddon;
      const searchTerm = query.slice(0, TERMINAL_SEARCH_QUERY_MAX_LENGTH);
      if (!addon || !searchTerm) {
        if (!searchTerm) clearSearchDecorations();
        return;
      }
      if (!terminal || terminal.cols <= 0 || terminal.rows <= 0) {
        setInvalidRegex(false);
        setSearchError("Search unavailable until the terminal is sized");
        return;
      }
      if (
        searchOptions.regex &&
        !compileTerminalSearchRegex(
          searchTerm,
          searchOptions.caseSensitive === true,
        )
      ) {
        addon.clearDecorations();
        setResult(EMPTY_RESULT);
        setInvalidRegex(true);
        setSearchError(null);
        return;
      }
      try {
        const found =
          direction === "next"
            ? addon.findNext(searchTerm, searchOptions)
            : addon.findPrevious(searchTerm, searchOptions);
        setInvalidRegex(false);
        setSearchError(null);
        if (!found) setResult(EMPTY_RESULT);
      } catch (error) {
        addon.clearDecorations();
        setResult(EMPTY_RESULT);
        setInvalidRegex(false);
        setSearchError(formatSearchFailure(error));
      }
    },
    [clearSearchDecorations, query, searchAddon, searchOptions, terminal],
  );

  const closeSearch = useCallback(() => {
    updateSearchState({ open: false });
    clearSearchDecorations();
    requestAnimationFrame(() => terminal?.focus());
  }, [clearSearchDecorations, terminal, updateSearchState]);

  useEffect(() => {
    if (!open || !active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSearch();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, closeSearch, open]);

  useEffect(() => {
    if (open && active) runSearch("next");
  }, [active, open, runSearch]);

  const handleQueryChange = useCallback((next: string) => {
    updateSearchState({
      query: next.slice(0, TERMINAL_SEARCH_QUERY_MAX_LENGTH),
    });
    setInvalidRegex(false);
    setSearchError(null);
  }, [updateSearchState]);

  const handleOptionChange = useCallback(
    (key: keyof TerminalSearchOptions, checked: boolean) => {
      updateSearchState({
        options: { ...options, [key]: checked },
      });
      setInvalidRegex(false);
      setSearchError(null);
    },
    [options, updateSearchState],
  );

  const panel = open && active ? (
    <div
      className={cn(
        "z-20 min-w-0 border-border bg-background text-foreground",
        variant === "island" &&
          "absolute right-3 top-3 w-[min(38rem,calc(100%-1.5rem))] rounded-lg border bg-popover p-2 shadow-md",
        variant === "lane" &&
          "relative order-first w-full shrink-0 border-b px-3 py-2",
        variant === "shelf" &&
          "relative order-last w-full shrink-0 border-t px-3 py-2",
      )}
      data-testid={`terminal-search-${variant}`}
      data-terminal-search-open="true"
    >
      <FindControls
        query={query}
        inputRef={inputRef}
        options={options}
        result={result}
        invalidRegex={invalidRegex}
        searchError={searchError}
        addonReady={searchAddon !== null}
        onQueryChange={handleQueryChange}
        onOptionChange={handleOptionChange}
        onNavigate={runSearch}
        onClose={closeSearch}
        variant={variant}
      />
    </div>
  ) : null;

  return (
    <>
      {panel}
      {showSwitcher ? (
        <TerminalSearchPrototypeSwitcher
          variant={variant}
          onVariantChange={onVariantChange}
        />
      ) : null}
    </>
  );
}
