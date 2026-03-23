import { useState, useRef, useCallback, useEffect } from "react";
import { getTransport } from "@/transport";

interface UseFileAutocompleteOptions {
  workspaceId?: string;
  threadId?: string;
}

interface UseFileAutocompleteResult {
  isOpen: boolean;
  filteredFiles: string[];
  query: string;
  triggerStart: number;
  handleInputChange: (text: string, cursorPos: number) => void;
  selectFile: (filePath: string) => string;
  dismiss: () => void;
}

/** Build a composite cache key from workspace + thread scope. */
function scopeKey(workspaceId: string, threadId?: string): string {
  return threadId ? `${workspaceId}:${threadId}` : workspaceId;
}

/** Cache file list per scope (workspace + thread) to avoid repeated IPC calls. */
const fileListCache = new Map<string, string[]>();

/** In-flight fetch promises keyed by scope, so concurrent callers reuse the same request. */
const inFlightFetches = new Map<string, Promise<string[]>>();

/**
 * Clear the cached file list for a scope.
 * Pass workspaceId (and optionally threadId) to clear a specific scope,
 * or call with no arguments to clear everything.
 */
export function clearFileListCache(workspaceId?: string, threadId?: string): void {
  if (workspaceId) {
    fileListCache.delete(scopeKey(workspaceId, threadId));
  } else {
    fileListCache.clear();
  }
}

/**
 * Hook for @ file autocomplete in the Composer.
 *
 * Detects `@` triggers by scanning backward from the cursor, lazy-loads
 * the workspace file list via IPC on first trigger, and filters results
 * by substring match. Caches file lists per scope at module scope.
 */
export function useFileAutocomplete({
  workspaceId,
  threadId,
}: UseFileAutocompleteOptions): UseFileAutocompleteResult {
  const [isOpen, setIsOpen] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);

  // Reset local state when scope changes so stale data isn't used.
  const prevScopeRef = useRef<string>("");
  useEffect(() => {
    const key = workspaceId ? scopeKey(workspaceId, threadId) : "";
    if (key !== prevScopeRef.current) {
      prevScopeRef.current = key;
      setAllFiles([]);
    }
  }, [workspaceId, threadId]);

  const loadFiles = useCallback(async (): Promise<string[] | undefined> => {
    if (!workspaceId) return;

    const key = scopeKey(workspaceId, threadId);

    // Return from cache if available.
    const cached = fileListCache.get(key);
    if (cached) {
      setAllFiles(cached);
      return cached;
    }

    // Reuse an in-flight fetch for the same scope instead of starting a new one.
    const existing = inFlightFetches.get(key);
    if (existing) {
      const files = await existing;
      setAllFiles(files);
      return files;
    }

    // Start a new fetch and store its promise so concurrent callers share it.
    const fetchPromise = getTransport()
      .listWorkspaceFiles(workspaceId, threadId)
      .then((files) => {
        fileListCache.set(key, files);
        return files;
      })
      .catch((err) => {
        console.error("[useFileAutocomplete] Failed to load files:", err);
        return [] as string[];
      })
      .finally(() => {
        inFlightFetches.delete(key);
      });

    inFlightFetches.set(key, fetchPromise);

    const files = await fetchPromise;
    // Only update state if scope hasn't changed during the async gap.
    const currentKey = scopeKey(workspaceId, threadId);
    if (currentKey === key) {
      setAllFiles(files);
    }
    return files;
  }, [workspaceId, threadId]);

  const handleInputChange = useCallback(
    async (text: string, cursorPos: number) => {
      // Find the @ trigger: scan backwards from cursor
      let atPos = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === "@") {
          // Valid trigger: @ at start of string or preceded by whitespace
          if (i === 0 || /\s/.test(text[i - 1])) {
            atPos = i;
          }
          break;
        }
        // Stop scanning if we hit whitespace (no @ trigger here)
        if (/\s/.test(ch)) break;
      }

      if (atPos === -1) {
        if (isOpen) {
          setIsOpen(false);
          setQuery("");
          setTriggerStart(-1);
        }
        return;
      }

      const q = text.slice(atPos + 1, cursorPos).toLowerCase();
      setQuery(q);
      setTriggerStart(atPos);

      // Lazy load file list on first @ trigger.
      // Always prefer the direct return from loadFiles() over the
      // closure-captured allFiles, which may be stale after an async gap.
      const loaded = allFiles.length === 0 ? await loadFiles() : undefined;
      const files = loaded ?? allFiles;

      // Filter: plain substring match
      const filtered =
        q.length === 0
          ? files.slice(0, 100) // Show first 100 when no query
          : files.filter((f) => f.toLowerCase().includes(q)).slice(0, 100);

      setFilteredFiles(filtered);
      setIsOpen(true);
    },
    [isOpen, allFiles, loadFiles],
  );

  const selectFile = useCallback((filePath: string): string => {
    setIsOpen(false);
    setQuery("");
    setTriggerStart(-1);
    return filePath;
  }, []);

  const dismiss = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setTriggerStart(-1);
  }, []);

  return {
    isOpen,
    filteredFiles,
    query,
    triggerStart,
    handleInputChange,
    selectFile,
    dismiss,
  };
}
