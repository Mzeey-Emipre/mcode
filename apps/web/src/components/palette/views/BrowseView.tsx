import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Folder, ArrowUp } from "lucide-react";
import { CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";
import { isMac } from "@/lib/platform";
import { Kbd } from "../Kbd";
import {
  splitBrowseQuery,
  filterBrowseEntries,
  getPaletteMode,
} from "../CommandPalette.logic";

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; isDir: boolean }[];
  isExactDirectory: boolean;
}

interface BrowseCapabilities {
  canAddCurrentDirectory: boolean;
  canAscend: boolean;
}

/**
 * Filesystem browser rendered inside the unified palette when the input
 * query is a path (~/, /foo, ./, ../, C:\…) or the bare `/` drives trigger.
 *
 * Behavior:
 * - The query is split into a directory portion and a leaf filter via
 *   `splitBrowseQuery`. The directory is fetched server-side; the leaf is a
 *   client-side substring filter against the returned entries.
 * - `Enter` on a highlighted folder appends its name + a trailing `/` to the
 *   query, descending into it.
 * - `Cmd/Ctrl+Enter` adds an exact, explicitly chosen directory as a project.
 */
export function BrowseView() {
  const query = useCommandPaletteStore((state) => state.query);
  const setQuery = useCommandPaletteStore((state) => state.setQuery);
  const setPendingConfirm = useCommandPaletteStore((state) => state.setPendingConfirm);
  const setPendingBack = useCommandPaletteStore((state) => state.setPendingBack);
  const close = useCommandPaletteStore((state) => state.close);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const beginNewThread = useWorkspaceStore((state) => state.beginNewThread);

  const isDrivesMode = getPaletteMode(query) === "drives";
  const { directoryPath, leafFilter } = getBrowseQueryParts(query, isDrivesMode);
  const [browseAttempt, setBrowseAttempt] = useState(0);
  const { result, loading, error } = useBrowseDirectory(directoryPath, browseAttempt);
  const { addError, isAdding, handleAdd } = useBrowseAddAction({
    query,
    leafFilter,
    isDrivesMode,
    result,
    loading,
    error,
    createWorkspace,
    beginNewThread,
    close,
  });
  const { handleSelect, handleAscend } = useBrowseNavigation({
    directoryPath,
    isDrivesMode,
    result,
    setQuery,
  });
  const filteredEntries = useMemo(
    () => getFilteredEntries(result, leafFilter),
    [result, leafFilter],
  );
  const { canAddCurrentDirectory, canAscend } = getBrowseCapabilities({
    query,
    leafFilter,
    isDrivesMode,
    result,
    loading,
    error,
    isAdding,
  });

  useRegisteredBrowseActions({
    canAddCurrentDirectory,
    handleAdd,
    canAscend,
    handleAscend,
    setPendingConfirm,
    setPendingBack,
  });

  return (
    <>
      <BrowseList
        loading={loading}
        error={error}
        result={result}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        filteredEntries={filteredEntries}
        canAscend={canAscend}
        onSelect={handleSelect}
        onAscend={handleAscend}
      />
      <BrowseError error={error} onRetry={() => setBrowseAttempt((attempt) => attempt + 1)} />
      <BrowseAddError addError={addError} onRetry={handleAdd} />
      <BrowseShortcuts canAscend={canAscend} canAddCurrentDirectory={canAddCurrentDirectory} />
    </>
  );
}

function getBrowseQueryParts(query: string, isDrivesMode: boolean) {
  if (isDrivesMode) return { directoryPath: "/", leafFilter: "" };
  return splitBrowseQuery(query);
}

function useBrowseDirectory(directoryPath: string, browseAttempt: number) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef("");

  useEffect(() => {
    const requestKey = directoryPath;
    inflightRef.current = requestKey;
    setResult(null);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const data = await getTransport().filesystemBrowse(directoryPath);
        if (inflightRef.current === requestKey) setResult(data);
      } catch {
        if (inflightRef.current === requestKey) setError("Could not browse this path.");
      } finally {
        if (inflightRef.current === requestKey) setLoading(false);
      }
    })();
  }, [directoryPath, browseAttempt]);

  return { result, loading, error };
}

function getFilteredEntries(result: BrowseResult | null, leafFilter: string) {
  if (!result) return [];
  return filterBrowseEntries(result.entries, leafFilter);
}

function getBrowseCapabilities({
  query,
  leafFilter,
  isDrivesMode,
  result,
  loading,
  error,
  isAdding,
}: {
  query: string;
  leafFilter: string;
  isDrivesMode: boolean;
  result: BrowseResult | null;
  loading: boolean;
  error: string | null;
  isAdding: boolean;
}): BrowseCapabilities {
  return {
    canAddCurrentDirectory: canAddCurrentDirectory({
      query,
      leafFilter,
      isDrivesMode,
      result,
      loading,
      error,
      isAdding,
    }),
    canAscend: Boolean(!isDrivesMode && leafFilter === "" && result?.parent),
  };
}

function canAddCurrentDirectory({
  query,
  leafFilter,
  isDrivesMode,
  result,
  loading,
  error,
  isAdding,
}: {
  query: string;
  leafFilter: string;
  isDrivesMode: boolean;
  result: BrowseResult | null;
  loading: boolean;
  error: string | null;
  isAdding: boolean;
}): boolean {
  const isHomeRoot = query === "~" || query === "~/" || query === "~\\";
  return Boolean(
    !isDrivesMode &&
      !isHomeRoot &&
      !loading &&
      !error &&
      !isAdding &&
      leafFilter === "" &&
      result?.isExactDirectory,
  );
}

function useBrowseAddAction({
  query,
  leafFilter,
  isDrivesMode,
  result,
  loading,
  error,
  createWorkspace,
  beginNewThread,
  close,
}: {
  query: string;
  leafFilter: string;
  isDrivesMode: boolean;
  result: BrowseResult | null;
  loading: boolean;
  error: string | null;
  createWorkspace: (name: string, path: string) => Promise<{ id: string }>;
  beginNewThread: (workspaceId?: string | null) => void;
  close: () => void;
}) {
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const isCurrentDirectoryAddable = canAddCurrentDirectory({
    query,
    leafFilter,
    isDrivesMode,
    result,
    loading,
    error,
    isAdding,
  });

  useEffect(() => {
    setAddError(null);
  }, [query]);

  const handleAdd = useCallback(async () => {
    if (!isCurrentDirectoryAddable || !result) return;
    const target = result.path;
    const name = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Untitled";
    setAddError(null);
    setIsAdding(true);
    try {
      const workspace = await createWorkspace(name, target);
      beginNewThread(workspace.id);
      close();
    } catch {
      setAddError("Could not add this folder. Try again.");
    } finally {
      setIsAdding(false);
    }
  }, [beginNewThread, close, createWorkspace, isCurrentDirectoryAddable, result]);

  return { addError, isAdding, handleAdd };
}

function useBrowseNavigation({
  directoryPath,
  isDrivesMode,
  result,
  setQuery,
}: {
  directoryPath: string;
  isDrivesMode: boolean;
  result: BrowseResult | null;
  setQuery: (query: string) => void;
}) {
  const handleSelect = useCallback(
    (entryName: string) => setQuery(getSelectedDirectoryPath(entryName, directoryPath, isDrivesMode)),
    [directoryPath, isDrivesMode, setQuery],
  );
  const handleAscend = useCallback(() => {
    if (result?.parent) setQuery(getParentDirectoryPath(result.parent));
  }, [result, setQuery]);

  return { handleSelect, handleAscend };
}

function getSelectedDirectoryPath(
  entryName: string,
  directoryPath: string,
  isDrivesMode: boolean,
): string {
  if (isDrivesMode) return /^[A-Za-z]:$/.test(entryName) ? `${entryName}\\` : entryName;
  const separator = directoryPath.includes("\\") && !directoryPath.includes("/") ? "\\" : "/";
  return directoryPath + entryName + separator;
}

function getParentDirectoryPath(parent: string): string {
  const separator = /^[A-Za-z]:/.test(parent) ? "\\" : "/";
  return parent.endsWith(separator) ? parent : parent + separator;
}

function useRegisteredBrowseActions({
  canAddCurrentDirectory,
  handleAdd,
  canAscend,
  handleAscend,
  setPendingConfirm,
  setPendingBack,
}: {
  canAddCurrentDirectory: boolean;
  handleAdd: () => Promise<void>;
  canAscend: boolean;
  handleAscend: () => void;
  setPendingConfirm: (action: (() => void) | null) => void;
  setPendingBack: (action: (() => void) | null) => void;
}) {
  useEffect(() => {
    setPendingConfirm(canAddCurrentDirectory ? handleAdd : null);
    return () => setPendingConfirm(null);
  }, [canAddCurrentDirectory, handleAdd, setPendingConfirm]);

  useEffect(() => {
    setPendingBack(canAscend ? handleAscend : null);
    return () => setPendingBack(null);
  }, [canAscend, handleAscend, setPendingBack]);
}

function BrowseList({
  loading,
  error,
  result,
  isDrivesMode,
  leafFilter,
  filteredEntries,
  canAscend,
  onSelect,
  onAscend,
}: {
  loading: boolean;
  error: string | null;
  result: BrowseResult | null;
  isDrivesMode: boolean;
  leafFilter: string;
  filteredEntries: BrowseResult["entries"];
  canAscend: boolean;
  onSelect: (entryName: string) => void;
  onAscend: () => void;
}) {
  return (
    <CommandList className="max-h-[360px] overflow-y-auto py-2">
      <BrowseMessages
        loading={loading}
        error={error}
        result={result}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        filteredEntries={filteredEntries}
      />
      <BrowseEntries
        error={error}
        result={result}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        filteredEntries={filteredEntries}
        canAscend={canAscend}
        onSelect={onSelect}
        onAscend={onAscend}
      />
    </CommandList>
  );
}

function BrowseMessages({
  loading,
  error,
  result,
  isDrivesMode,
  leafFilter,
  filteredEntries,
}: {
  loading: boolean;
  error: string | null;
  result: BrowseResult | null;
  isDrivesMode: boolean;
  leafFilter: string;
  filteredEntries: BrowseResult["entries"];
}) {
  return (
    <>
      <BrowseLoadingMessage loading={loading} hasResult={Boolean(result)} />
      <BrowsePathErrorMessage error={error} />
      <BrowseResolutionWarning
        loading={loading}
        error={error}
        isExactDirectory={result?.isExactDirectory}
        isDrivesMode={isDrivesMode}
      />
      <BrowseEmptyMessage
        loading={loading}
        error={error}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        entryCount={filteredEntries.length}
      />
    </>
  );
}

function BrowseLoadingMessage({ loading, hasResult }: { loading: boolean; hasResult: boolean }) {
  if (!loading || hasResult) return null;
  return <CommandEmpty>Loading…</CommandEmpty>;
}

function BrowsePathErrorMessage({ error }: { error: string | null }) {
  if (!error) return null;
  return <CommandEmpty>{error}</CommandEmpty>;
}

function BrowseResolutionWarning({
  loading,
  error,
  isExactDirectory,
  isDrivesMode,
}: {
  loading: boolean;
  error: string | null;
  isExactDirectory: boolean | undefined;
  isDrivesMode: boolean;
}) {
  if (loading || error || isExactDirectory !== false || isDrivesMode) return null;

  return (
    <div data-testid="browse-resolution-warning" className="mx-3 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="alert">
      This path is not a folder. Choose a listed folder or revise the path.
    </div>
  );
}

function BrowseEmptyMessage({
  loading,
  error,
  isDrivesMode,
  leafFilter,
  entryCount,
}: {
  loading: boolean;
  error: string | null;
  isDrivesMode: boolean;
  leafFilter: string;
  entryCount: number;
}) {
  if (loading || error || isDrivesMode || entryCount > 0) return null;

  return (
    <CommandEmpty>
      {leafFilter ? `No folders match "${leafFilter}".` : "No subfolders here."}
    </CommandEmpty>
  );
}

function BrowseEntries({
  error,
  result,
  isDrivesMode,
  leafFilter,
  filteredEntries,
  canAscend,
  onSelect,
  onAscend,
}: {
  error: string | null;
  result: BrowseResult | null;
  isDrivesMode: boolean;
  leafFilter: string;
  filteredEntries: BrowseResult["entries"];
  canAscend: boolean;
  onSelect: (entryName: string) => void;
  onAscend: () => void;
}) {
  if (error) return null;

  return (
    <CommandGroup heading={isDrivesMode ? "Drives" : "Folders"} className="px-2 pb-1">
      {canAscend && result?.parent && leafFilter === "" && (
        <CommandItem
          key="__parent__"
          value="__parent__"
          keywords={[".."]}
          onSelect={onAscend}
          className="h-[40px] gap-3 px-[12px] text-[14px] text-foreground/85"
        >
          <ArrowUp size={14} strokeWidth={2.25} className="shrink-0 text-primary/80" />
          <span className="font-mono">..</span>
          <span className="ml-auto text-[12px] text-muted-foreground/55">Parent folder</span>
        </CommandItem>
      )}
      {filteredEntries.map((entry) => (
        <CommandItem
          key={entry.name}
          value={entry.name}
          keywords={[entry.name]}
          onSelect={() => onSelect(entry.name)}
          className="h-[40px] gap-3 px-[12px] text-[14px]"
        >
          <Folder size={15} strokeWidth={1.8} className="shrink-0 text-muted-foreground/70" />
          <span className="truncate text-foreground">{entry.name}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function BrowseError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (!error) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2 text-xs" role="alert">
      <span className="text-muted-foreground">Check the path or retry the folder listing.</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function BrowseAddError({ addError, onRetry }: { addError: string | null; onRetry: () => void }) {
  if (!addError) return null;

  return (
    <div data-testid="browse-add-error" className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2 text-xs" role="alert">
      <span className="text-destructive">{addError}</span>
      <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function BrowseShortcuts({
  canAscend,
  canAddCurrentDirectory,
}: BrowseCapabilities) {
  return (
    <div
      data-testid="browse-shortcuts"
      className="hidden min-h-[44px] shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-[16px] py-[10px] text-[12px] text-muted-foreground/75 sm:flex"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex shrink-0 items-center gap-1.5"><Kbd>Enter</Kbd> Open folder</span>
        {canAscend && <span className="flex shrink-0 items-center gap-1.5"><Kbd>Alt+↑</Kbd> Back</span>}
      </div>
      {canAddCurrentDirectory && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Kbd>{isMac ? "⌘+Enter" : "Ctrl+Enter"}</Kbd> Add project
        </span>
      )}
    </div>
  );
}
