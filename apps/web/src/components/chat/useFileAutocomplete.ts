import { useState, useRef, useCallback } from "react";
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

/** Cache file list per workspace to avoid repeated IPC calls. */
const fileListCache = new Map<string, string[]>();

/** Clear the cache (call after git operations). */
export function clearFileListCache(workspaceId?: string): void {
  if (workspaceId) {
    fileListCache.delete(workspaceId);
  } else {
    fileListCache.clear();
  }
}

export function useFileAutocomplete({
  workspaceId,
  threadId,
}: UseFileAutocompleteOptions): UseFileAutocompleteResult {
  const [isOpen, setIsOpen] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);
  const loadingRef = useRef(false);

  const loadFiles = useCallback(async () => {
    if (!workspaceId || loadingRef.current) return;

    const cached = fileListCache.get(workspaceId);
    if (cached) {
      setAllFiles(cached);
      return cached;
    }

    loadingRef.current = true;
    try {
      const files = await getTransport().listWorkspaceFiles(workspaceId, threadId);
      fileListCache.set(workspaceId, files);
      setAllFiles(files);
      return files;
    } catch (err) {
      console.error("[useFileAutocomplete] Failed to load files:", err);
      return [];
    } finally {
      loadingRef.current = false;
    }
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

      // Lazy load file list on first @ trigger
      let files = allFiles;
      if (files.length === 0) {
        const loaded = await loadFiles();
        if (loaded) files = loaded;
      }

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
