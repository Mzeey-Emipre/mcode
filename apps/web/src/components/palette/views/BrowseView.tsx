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
  const query = useCommandPaletteStore((s) => s.query);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const setPendingConfirm = useCommandPaletteStore((s) => s.setPendingConfirm);
  const setPendingBack = useCommandPaletteStore((s) => s.setPendingBack);
  const close = useCommandPaletteStore((s) => s.close);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const beginNewThread = useWorkspaceStore((s) => s.beginNewThread);

  const mode = getPaletteMode(query);
  const isDrivesMode = mode === "drives";

  // Split the raw query into dir + leaf parts. In drives mode we send `/` as-is.
  const { directoryPath, leafFilter } = useMemo(() => {
    if (isDrivesMode) return { directoryPath: "/", leafFilter: "" };
    return splitBrowseQuery(query);
  }, [query, isDrivesMode]);

  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [browseAttempt, setBrowseAttempt] = useState(0);
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Cache the most recent in-flight request key so that a stale response
  // (e.g. from a directory the user has already typed past) cannot overwrite
  // newer state. Without this, fast typing can paint old entries.
  const inflightRef = useRef<string>("");

  useEffect(() => {
    const reqKey = directoryPath;
    inflightRef.current = reqKey;
    // Drop the previous directory's entries immediately so the user can't
    // pick a stale folder belonging to the path they just navigated away from.
    setResult(null);
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await getTransport().filesystemBrowse(directoryPath);
        if (inflightRef.current !== reqKey) return;
        setResult(data);
      } catch {
        if (inflightRef.current !== reqKey) return;
        setError("Could not browse this path.");
      } finally {
        if (inflightRef.current === reqKey) setLoading(false);
      }
    })();
  }, [directoryPath, browseAttempt]);

  useEffect(() => {
    setAddError(null);
  }, [query]);

  // Folders only — files are pointless when picking a project root.
  const filteredEntries = useMemo(() => {
    if (!result) return [];
    return filterBrowseEntries(result.entries, leafFilter);
  }, [result, leafFilter]);

  const isHomeRoot = query === "~" || query === "~/" || query === "~\\";
  const canAddCurrentDirectory = Boolean(
    !isDrivesMode
      && !isHomeRoot
      && !loading
      && !error
      && !isAdding
      && leafFilter === ""
      && result?.isExactDirectory,
  );
  const canAscend = Boolean(!isDrivesMode && leafFilter === "" && result?.parent);

  /**
   * Add the currently-typed directory as a workspace.
   * The path used is the resolved server `result.path`, not the raw query —
   * this guarantees ~ and relative paths are expanded.
   */
  const handleAdd = useCallback(async () => {
    if (!canAddCurrentDirectory || !result) return;
    const target = result.path;
    const name = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Untitled";
    setAddError(null);
    setIsAdding(true);
    try {
      const ws = await createWorkspace(name, target);
      beginNewThread(ws.id);
      close();
    } catch {
      setAddError("Could not add this folder. Try again.");
    } finally {
      setIsAdding(false);
    }
  }, [
    result,
    canAddCurrentDirectory,
    createWorkspace,
    beginNewThread,
    close,
  ]);

  /**
   * Handle a click on a directory entry: append its name + `/` to the query,
   * descending into it.
   */
  const handleSelect = useCallback(
    (entryName: string) => {
      // Drives mode: replace the entire query with the chosen drive path.
      if (isDrivesMode) {
        // Defensively root bare drive letters ("C:" → "C:\") so the next
        // browse step doesn't get a drive-relative path that silently drops
        // out of browse mode. listWindowsDrives() already returns the rooted
        // form, so this is a safeguard for callers that might pass bare letters.
        const rooted = /^[A-Za-z]:$/.test(entryName) ? `${entryName}\\` : entryName;
        setQuery(rooted);
        return;
      }
      const separator = directoryPath.includes("\\") && !directoryPath.includes("/") ? "\\" : "/";
      const newQuery = directoryPath + entryName + separator;
      setQuery(newQuery);
    },
    [directoryPath, isDrivesMode, setQuery],
  );

  /** Append `..` to ascend one directory by replacing the query with the parent. */
  const handleAscend = useCallback(() => {
    if (!result?.parent) return;
    // Always present POSIX-style separators in the input for readability,
    // unless we're on a Windows-rooted path (drive letter prefix).
    const parent = result.parent;
    const useBackslash = /^[A-Za-z]:/.test(parent);
    const sep = useBackslash ? "\\" : "/";
    const tail = parent.endsWith(sep) ? parent : parent + sep;
    setQuery(tail);
  }, [result, setQuery]);

  // Register only viable palette actions. This prevents Ctrl/Cmd+Enter from
  // adding a loading, filtered, or ancestor-fallback path.
  useEffect(() => {
    setPendingConfirm(canAddCurrentDirectory ? handleAdd : null);
    return () => setPendingConfirm(null);
  }, [canAddCurrentDirectory, handleAdd, setPendingConfirm]);

  useEffect(() => {
    setPendingBack(canAscend ? handleAscend : null);
    return () => setPendingBack(null);
  }, [canAscend, handleAscend, setPendingBack]);

  return (
    <>
      <CommandList className="max-h-[360px] overflow-y-auto py-2">
        {loading && !result && <CommandEmpty>Loading…</CommandEmpty>}
        {error && <CommandEmpty>{error}</CommandEmpty>}
        {!loading && !error && result?.isExactDirectory === false && !isDrivesMode && (
          <div data-testid="browse-resolution-warning" className="mx-3 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="alert">
            This path is not a folder. Choose a listed folder or revise the path.
          </div>
        )}
        {!loading && !error && filteredEntries.length === 0 && !isDrivesMode && (
          <CommandEmpty>
            {leafFilter ? `No folders match "${leafFilter}".` : "No subfolders here."}
          </CommandEmpty>
        )}

        {!error && (
          <CommandGroup heading={isDrivesMode ? "Drives" : "Folders"} className="px-2 pb-1">
            {!isDrivesMode && result?.parent && leafFilter === "" && (
              <CommandItem
                key="__parent__"
                value="__parent__"
                keywords={[".."]}
                onSelect={handleAscend}
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
                onSelect={() => handleSelect(entry.name)}
                className="h-[40px] gap-3 px-[12px] text-[14px]"
              >
                <Folder size={15} strokeWidth={1.8} className="shrink-0 text-muted-foreground/70" />
                <span className="truncate text-foreground">{entry.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      {error && (
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2 text-xs" role="alert">
          <span className="text-muted-foreground">Check the path or retry the folder listing.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setBrowseAttempt((attempt) => attempt + 1)}>
            Retry
          </Button>
        </div>
      )}

      {addError && (
        <div data-testid="browse-add-error" className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2 text-xs" role="alert">
          <span className="text-destructive">{addError}</span>
          <Button type="button" size="sm" variant="ghost" onClick={handleAdd}>
            Retry
          </Button>
        </div>
      )}

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
    </>
  );
}
