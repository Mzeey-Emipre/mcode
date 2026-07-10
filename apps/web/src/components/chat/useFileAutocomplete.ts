import { useState, useRef, useCallback, useEffect } from "react";
import { getTransport } from "@/transport";

interface UseFileAutocompleteOptions {
  workspaceId?: string;
  threadId?: string;
  providerId?: string;
}

export type MentionSuggestion =
  | {
      id: string;
      kind: "agent";
      group: "Agents";
      label: string;
      name: string;
      path: string;
      provider: "codex";
      description?: string;
    }
  | {
      id: string;
      kind: "file";
      group: "Files";
      label: string;
      path: string;
    };

interface UseFileAutocompleteResult {
  isOpen: boolean;
  suggestions: MentionSuggestion[];
  query: string;
  triggerStart: number;
  handleInputChange: (text: string, cursorPos: number) => Promise<void>;
  selectSuggestion: (suggestion: MentionSuggestion) => MentionSuggestion;
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

/** Cache Codex agent suggestions per scope. */
const codexAgentCache = new Map<string, MentionSuggestion[]>();

/** In-flight Codex agent fetches keyed by scope. */
const inFlightAgentFetches = new Map<string, Promise<MentionSuggestion[]>>();

/** Mounted hooks that must discard local data after a cache invalidation. */
const cacheInvalidationListeners = new Set<(key?: string) => void>();

/**
 * Clear the cached file list for a scope.
 * Pass workspaceId (and optionally threadId) to clear a specific scope,
 * or call with no arguments to clear everything.
 */
export function clearFileListCache(workspaceId?: string, threadId?: string): void {
  if (workspaceId) {
    const key = scopeKey(workspaceId, threadId);
    fileListCache.delete(key);
    codexAgentCache.delete(key);
    for (const listener of cacheInvalidationListeners) listener(key);
  } else {
    fileListCache.clear();
    codexAgentCache.clear();
    for (const listener of cacheInvalidationListeners) listener();
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
  providerId,
}: UseFileAutocompleteOptions): UseFileAutocompleteResult {
  const [isOpen, setIsOpen] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [allAgents, setAllAgents] = useState<MentionSuggestion[]>([]);
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);
  const requestEpochRef = useRef(0);

  // Reset local state when scope changes so stale data isn't used.
  const prevScopeRef = useRef<string>("");
  useEffect(() => {
    const key = workspaceId ? scopeKey(workspaceId, threadId) : "";
    if (key !== prevScopeRef.current) {
      requestEpochRef.current += 1;
      prevScopeRef.current = key;
      setAllFiles([]);
      setAllAgents([]);
      setSuggestions([]);
      setIsOpen(false);
    }
  }, [workspaceId, threadId]);

  useEffect(() => {
    const listener = (invalidatedKey?: string) => {
      if (invalidatedKey && invalidatedKey !== prevScopeRef.current) return;
      requestEpochRef.current += 1;
      setAllFiles([]);
      setAllAgents([]);
      setSuggestions([]);
      setIsOpen(false);
    };
    cacheInvalidationListeners.add(listener);
    return () => {
      requestEpochRef.current += 1;
      cacheInvalidationListeners.delete(listener);
    };
  }, []);

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
    if (prevScopeRef.current === key) {
      setAllFiles(files);
    }
    return files;
  }, [workspaceId, threadId]);

  const loadAgents = useCallback(async (): Promise<MentionSuggestion[]> => {
    if (!workspaceId || providerId !== "codex") return [];

    const key = scopeKey(workspaceId, threadId);
    const cached = codexAgentCache.get(key);
    if (cached) {
      setAllAgents(cached);
      return cached;
    }

    const existing = inFlightAgentFetches.get(key);
    if (existing) {
      const agents = await existing;
      setAllAgents(agents);
      return agents;
    }

    const fetchPromise = getTransport()
      .listCodexAgents(workspaceId, threadId)
      .then((agents) =>
        agents.map((agent) => ({
          id: `agent:${agent.path}`,
          kind: "agent" as const,
          group: "Agents" as const,
          label: agent.name,
          name: agent.name,
          path: agent.path,
          provider: "codex" as const,
          ...(agent.description ? { description: agent.description } : {}),
        })),
      )
      .then((agents) => {
        codexAgentCache.set(key, agents);
        return agents;
      })
      .catch((err) => {
        console.error("[useFileAutocomplete] Failed to load Codex agents:", err);
        return [] as MentionSuggestion[];
      })
      .finally(() => {
        inFlightAgentFetches.delete(key);
      });

    inFlightAgentFetches.set(key, fetchPromise);

    const agents = await fetchPromise;
    if (prevScopeRef.current === key) {
      setAllAgents(agents);
    }
    return agents;
  }, [workspaceId, threadId, providerId]);

  const handleInputChange = useCallback(
    async (text: string, cursorPos: number) => {
      const requestEpoch = ++requestEpochRef.current;
      const requestScope = workspaceId ? scopeKey(workspaceId, threadId) : "";
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
        setIsOpen(false);
        setSuggestions([]);
        setQuery("");
        setTriggerStart(-1);
        return;
      }

      const q = text.slice(atPos + 1, cursorPos).toLowerCase();
      setQuery(q);
      setTriggerStart(atPos);

      // Lazy load file list on first @ trigger.
      // Always prefer the direct return from loadFiles() over the
      // closure-captured allFiles, which may be stale after an async gap.
      const [loadedFiles, loadedAgents] = await Promise.all([
        allFiles.length === 0 ? loadFiles() : Promise.resolve(undefined),
        providerId === "codex" && allAgents.length === 0 ? loadAgents() : Promise.resolve(undefined),
      ]);
      const loaded = loadedFiles;
      const files = loaded ?? allFiles;
      const agents = providerId === "codex" ? (loadedAgents ?? allAgents) : [];

      if (
        requestEpochRef.current !== requestEpoch ||
        prevScopeRef.current !== requestScope
      ) {
        return;
      }

      const fileSuggestions: MentionSuggestion[] = files.map((filePath) => ({
        id: `file:${filePath}`,
        kind: "file",
        group: "Files",
        label: filePath,
        path: filePath,
      }));

      const allSuggestions = [...agents, ...fileSuggestions];
      const matches = (suggestion: MentionSuggestion) => {
        if (q.length === 0) return true;
        const haystack =
          suggestion.kind === "agent"
            ? `${suggestion.label} ${suggestion.description ?? ""}`.toLowerCase()
            : suggestion.path.toLowerCase();
        return haystack.includes(q);
      };
      const filtered =
        q.length === 0
          ? [...agents.slice(0, 20), ...fileSuggestions.slice(0, 80)]
          : allSuggestions.filter(matches).slice(0, 100);

      setSuggestions(filtered);
      setIsOpen(true);
    },
    [workspaceId, threadId, allFiles, allAgents, loadFiles, loadAgents, providerId],
  );

  const selectSuggestion = useCallback((suggestion: MentionSuggestion): MentionSuggestion => {
    requestEpochRef.current += 1;
    setIsOpen(false);
    setSuggestions([]);
    setQuery("");
    setTriggerStart(-1);
    return suggestion;
  }, []);

  const dismiss = useCallback(() => {
    requestEpochRef.current += 1;
    setIsOpen(false);
    setSuggestions([]);
    setQuery("");
    setTriggerStart(-1);
  }, []);

  return {
    isOpen,
    suggestions,
    query,
    triggerStart,
    handleInputChange,
    selectSuggestion,
    dismiss,
  };
}
