import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Folder, ArrowUp } from "lucide-react";
import { CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
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
}

/**
 * Filesystem browser rendered inside the unified palette when the input
 * query is a path (~/, /foo, ./, ../, C:\…) or the bare `/` drives trigger.
 *
 * Behavior:
 * - The query is split into a directory portion and a leaf filter via
 *   `splitBrowseQuery`. The directory is fetched server-side; the leaf is a
 *   client-side prefix filter against the returned entries.
 * - `Enter` on a highlighted folder appends its name + a trailing `/` to the
 *   query, descending into it.
 * - `Cmd/Ctrl+Enter` adds the current directory path as a project, regardless
 *   of which entry is highlighted.
 */
export function BrowseView() {
  const query = useCommandPaletteStore((s) => s.query);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const setPendingConfirm = useCommandPaletteStore((s) => s.setPendingConfirm);
  const close = useCommandPaletteStore((s) => s.close);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const setPendingNewThread = useWorkspaceStore((s) => s.setPendingNewThread);

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
  }, [directoryPath]);

  // Folders only — files are pointless when picking a project root.
  const filteredEntries = useMemo(() => {
    if (!result) return [];
    return filterBrowseEntries(result.entries, leafFilter);
  }, [result, leafFilter]);

  /**
   * Add the currently-typed directory as a workspace.
   * The path used is the resolved server `result.path`, not the raw query —
   * this guarantees ~ and relative paths are expanded.
   */
  const handleAdd = useCallback(async () => {
    const target = isDrivesMode ? null : result?.path;
    if (!target) return;
    const name = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Untitled";
    try {
      const ws = await createWorkspace(name, target);
      setActiveWorkspace(ws.id);
      // Drop straight into the new-thread composer on the just-added project.
      // setActiveWorkspace clears `pendingNewThread`, so re-set it AFTER
      // activation; clear the active thread so ChatView shows the composer
      // rather than a stale thread. Mirrors ProjectsView's "newThread" chain.
      setActiveThread(null);
      setPendingNewThread(true);
      close();
    } catch (err) {
      console.error("Failed to create workspace:", err);
    }
  }, [
    result,
    isDrivesMode,
    createWorkspace,
    setActiveWorkspace,
    setActiveThread,
    setPendingNewThread,
    close,
  ]);

  // Register the confirm handler so Cmd/Ctrl+Enter in the shell adds the folder.
  // Pass `handleAdd` directly — Zustand's setter does a shallow merge, not a
  // functional update, so wrapping it in `() => handleAdd` would store a thunk
  // that *returns* handleAdd instead of being it.
  useEffect(() => {
    setPendingConfirm(handleAdd);
    return () => setPendingConfirm(null);
  }, [handleAdd, setPendingConfirm]);

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
      const newQuery = directoryPath + entryName + "/";
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

  return (
    <>
      <CommandList className="max-h-80 overflow-y-auto">
        {loading && !result && <CommandEmpty>Loading…</CommandEmpty>}
        {error && <CommandEmpty>{error}</CommandEmpty>}
        {!loading && !error && filteredEntries.length === 0 && !isDrivesMode && (
          <CommandEmpty>
            {leafFilter ? `No folders match "${leafFilter}".` : "No subfolders here."}
          </CommandEmpty>
        )}

        {!error && (
          <CommandGroup
            heading={
              <span className="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
                {isDrivesMode ? "Drives" : "Folders"}
              </span>
            }
          >
            {!isDrivesMode && result?.parent && leafFilter === "" && (
              <CommandItem
                key="__parent__"
                value="__parent__"
                keywords={[".."]}
                onSelect={handleAscend}
                className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-foreground/85"
              >
                <ArrowUp size={13} strokeWidth={2.25} className="shrink-0 text-primary/80" />
                <span className="font-mono">..</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground/55">parent</span>
              </CommandItem>
            )}

            {filteredEntries.map((entry) => (
              <CommandItem
                key={entry.name}
                value={entry.name}
                keywords={[entry.name]}
                onSelect={() => handleSelect(entry.name)}
                className="flex items-center gap-2.5 px-3 py-1.5 text-[13px]"
              >
                <Folder size={13} strokeWidth={2} className="shrink-0 text-muted-foreground/70" />
                <span className="font-mono text-foreground">{entry.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground/55">
        <span className="flex items-center gap-1.5">
          <Kbd>Enter</Kbd> open
          <span className="opacity-40">·</span>
          <Kbd>⌫</Kbd> back
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{isMac ? "⌘+Enter" : "Ctrl+Enter"}</Kbd> add project
        </span>
      </div>
    </>
  );
}
