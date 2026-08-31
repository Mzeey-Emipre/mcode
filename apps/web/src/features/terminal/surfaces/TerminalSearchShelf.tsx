import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretUp,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  TERMINAL_SEARCH_STATE_DEFAULT,
  useTerminalStore,
  type TerminalSearchOptions,
} from "@/features/terminal/state/terminalStore";

/** Maximum query length accepted by the terminal search Shelf. */
export const TERMINAL_SEARCH_QUERY_MAX_LENGTH = 256;

/** Compiles a regular-expression query without allowing invalid input to escape. */
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

/** Search direction requested by a Shelf navigation action. */
export type TerminalSearchDirection = "next" | "previous";

/** Lifecycle state of the PTY-owned xterm SearchAddon. */
export type TerminalSearchAddonState = "loading" | "ready" | "failed";

/** Outcome returned by the TerminalView-owned SearchAddon call. */
export type TerminalSearchRunResult =
  | "found"
  | "no-matches"
  | "invalid-regex"
  | { readonly kind: "error"; readonly message: string };

interface TerminalSearchShelfProps {
  /** PTY whose retained scrollback is searched. */
  readonly ptyId: string;
  /** Whether this PTY is the visible active terminal. */
  readonly active: boolean;
  /** Runs a search through the owning TerminalView SearchAddon. */
  readonly onSearch: (
    query: string,
    options: TerminalSearchOptions,
    direction: TerminalSearchDirection,
  ) => TerminalSearchRunResult;
  /** Clears SearchAddon decorations and the PTY match snapshot. */
  readonly onClear: () => void;
  /** Restores focus to the owning xterm instance. */
  readonly onRestoreFocus: () => void;
  /** Current lifecycle state of the xterm SearchAddon. */
  readonly addonState: TerminalSearchAddonState;
  /** Retries loading the xterm SearchAddon after a failure. */
  readonly onRetry: () => void;
}

interface SearchOptionCheckboxProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

function SearchOptionCheckbox({
  label,
  checked,
  onCheckedChange,
}: SearchOptionCheckboxProps) {
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

interface SearchOptionsPopoverProps {
  readonly options: TerminalSearchOptions;
  readonly onChange: (key: keyof TerminalSearchOptions, checked: boolean) => void;
}

function SearchOptionsPopover({ options, onChange }: SearchOptionsPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Terminal search options"
            data-testid="terminal-search-options-trigger"
          />
        }
      >
        <SlidersHorizontal aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64 p-2">
        <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">
          Search options
        </div>
        <div className="flex flex-col items-stretch gap-0">
          <SearchOptionCheckbox
            label="Case sensitive"
            checked={options.caseSensitive}
            onCheckedChange={(checked) => onChange("caseSensitive", checked)}
          />
          <SearchOptionCheckbox
            label="Whole word"
            checked={options.wholeWord}
            onCheckedChange={(checked) => onChange("wholeWord", checked)}
          />
          <SearchOptionCheckbox
            label="Regular expression"
            checked={options.regex}
            onCheckedChange={(checked) => onChange("regex", checked)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface SearchMatchStatusProps {
  readonly query: string;
  readonly resultIndex: number;
  readonly resultCount: number;
  readonly invalidRegex: boolean;
  readonly searchError: string | null;
  readonly addonState: TerminalSearchAddonState;
}

function SearchMatchStatus({
  query,
  resultIndex,
  resultCount,
  invalidRegex,
  searchError,
  addonState,
}: SearchMatchStatusProps) {
  const text = getSearchMatchStatus({
    query,
    resultIndex,
    resultCount,
    invalidRegex,
    searchError,
    addonState,
  });

  return (
    <output
      className="min-w-0 flex-1 truncate whitespace-nowrap text-xs tabular-nums text-muted-foreground"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {text}
    </output>
  );
}

function getSearchMatchStatus({
  query,
  resultIndex,
  resultCount,
  invalidRegex,
  searchError,
  addonState,
}: SearchMatchStatusProps): string {
  if (!query) return "";
  if (addonState !== "ready") return addonState === "loading" ? "Loading search…" : "Search unavailable";
  if (invalidRegex) return "Invalid regular expression";
  if (searchError) return searchError;
  if (resultCount === 0) return "No matches";
  return resultIndex >= 0 ? `${resultIndex + 1} / ${resultCount}` : `${resultCount} matches`;
}

interface TerminalSearchControlsProps {
  readonly query: string;
  readonly options: TerminalSearchOptions;
  readonly resultIndex: number;
  readonly resultCount: number;
  readonly invalidRegex: boolean;
  readonly searchError: string | null;
  readonly addonState: TerminalSearchAddonState;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onQueryChange: (query: string) => void;
  readonly onOptionChange: (key: keyof TerminalSearchOptions, checked: boolean) => void;
  readonly onNavigate: (direction: "next" | "previous") => void;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}

function TerminalSearchControls({
  query,
  options,
  resultIndex,
  resultCount,
  invalidRegex,
  searchError,
  addonState,
  inputRef,
  onQueryChange,
  onOptionChange,
  onNavigate,
  onClose,
  onRetry,
}: TerminalSearchControlsProps) {
  const navigationDisabled =
    addonState !== "ready" || invalidRegex || searchError !== null || !query || resultCount === 0;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && !navigationDisabled) {
      event.preventDefault();
      event.stopPropagation();
      onNavigate(event.shiftKey ? "previous" : "next");
    }
  };

  return (
    <div className="grid min-w-0 gap-1.5" data-testid="terminal-search-controls">
      <div className="flex min-w-0 items-center gap-1.5" data-testid="terminal-search-primary-row">
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
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close terminal search"
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </div>
      <div
        className="flex min-w-0 items-center gap-1.5"
        data-testid="terminal-search-secondary-row"
      >
        <SearchMatchStatus
          query={query}
          resultIndex={resultIndex}
          resultCount={resultCount}
          invalidRegex={invalidRegex}
          searchError={searchError}
          addonState={addonState}
        />
        <div className="ml-auto flex shrink-0 items-center gap-0.5" data-testid="terminal-search-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous terminal match"
            disabled={navigationDisabled}
            onClick={() => onNavigate("previous")}
          >
            <CaretUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next terminal match"
            disabled={navigationDisabled}
            onClick={() => onNavigate("next")}
          >
            <CaretDown aria-hidden />
          </Button>
          {addonState === "failed" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Retry terminal search"
              onClick={onRetry}
            >
              <ArrowClockwise aria-hidden />
            </Button>
          ) : null}
          <SearchOptionsPopover options={options} onChange={onOptionChange} />
        </div>
      </div>
    </div>
  );
}

/** Renders the PTY-scoped bottom search Shelf for the active terminal. */
export function TerminalSearchShelf({
  ptyId,
  active,
  onSearch,
  onClear,
  onRestoreFocus,
  addonState,
  onRetry,
}: TerminalSearchShelfProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const search = useTerminalStore(
    (state) => state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT,
  );
  const closeTerminalSearch = useTerminalStore((state) => state.closeTerminalSearch);
  const setTerminalSearchQuery = useTerminalStore((state) => state.setTerminalSearchQuery);
  const setTerminalSearchOptions = useTerminalStore((state) => state.setTerminalSearchOptions);
  const { open, query, options, resultIndex, resultCount } = search;
  const { caseSensitive, wholeWord, regex } = options;

  const [invalidRegex, setInvalidRegex] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const searchOptions = useMemo<TerminalSearchOptions>(
    () => ({
      caseSensitive,
      wholeWord,
      regex,
    }),
    [caseSensitive, wholeWord, regex],
  );

  const clearSearch = useCallback(() => {
    onClear();
    setInvalidRegex(false);
    setSearchError(null);
  }, [onClear]);

  const runSearch = useCallback(
    (direction: "next" | "previous") => {
      if (addonState !== "ready") return;
      const searchTerm = query.slice(0, TERMINAL_SEARCH_QUERY_MAX_LENGTH);
      if (!searchTerm) {
        clearSearch();
        return;
      }

      const result = onSearch(searchTerm, searchOptions, direction);
      if (result === "invalid-regex") {
        setInvalidRegex(true);
        setSearchError(null);
        return;
      }
      if (typeof result === "object") {
        setInvalidRegex(false);
        setSearchError(result.message);
        return;
      }
      setInvalidRegex(false);
      setSearchError(null);
    },
    [addonState, clearSearch, onSearch, query, searchOptions],
  );

  const closeSearch = useCallback(() => {
    closeTerminalSearch(ptyId);
    onClear();
    requestAnimationFrame(onRestoreFocus);
  }, [closeTerminalSearch, onClear, onRestoreFocus, ptyId]);

  useEffect(() => {
    if (!open || !active) return;
    const focusQuery = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const frame = requestAnimationFrame(focusQuery);
    return () => cancelAnimationFrame(frame);
  }, [active, open]);

  useEffect(() => {
    if (!open || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, closeSearch, open]);

  useEffect(() => {
    if (!open || !active) return;
    // oxlint-disable-next-line react/set-state-in-effect -- The xterm search add-on reports the current result into local UI state.
    runSearch("next");
  }, [active, open, runSearch]);

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setTerminalSearchQuery(
        ptyId,
        nextQuery.slice(0, TERMINAL_SEARCH_QUERY_MAX_LENGTH),
      );
      setInvalidRegex(false);
      setSearchError(null);
    },
    [ptyId, setTerminalSearchQuery],
  );

  const handleOptionChange = useCallback(
    (key: keyof TerminalSearchOptions, checked: boolean) => {
      setTerminalSearchOptions(ptyId, { ...options, [key]: checked });
      setInvalidRegex(false);
      setSearchError(null);
    },
    [options, ptyId, setTerminalSearchOptions],
  );

  if (!active || !open) return null;

  return (
    <div
      className="w-full min-w-0 shrink-0 border-t border-border bg-background px-3 py-2 text-foreground"
      data-testid="terminal-search-shelf"
      data-terminal-search-open="true"
    >
      <TerminalSearchControls
        query={query}
        options={options}
        resultIndex={resultIndex}
        resultCount={resultCount}
        invalidRegex={invalidRegex}
        searchError={searchError}
        inputRef={inputRef}
        onQueryChange={handleQueryChange}
        onOptionChange={handleOptionChange}
        onNavigate={runSearch}
        onClose={closeSearch}
        addonState={addonState}
        onRetry={onRetry}
      />
    </div>
  );
}
