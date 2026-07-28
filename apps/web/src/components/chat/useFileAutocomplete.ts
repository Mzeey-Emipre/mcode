import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { getTransport } from "@/transport";
import {
  providerCatalogCacheKey,
  useProviderCatalogStore,
} from "@/stores/providerCatalogStore";
import type { ProviderCatalogRequest, SelectableProviderAgent } from "@mcode/contracts";

interface UseFileAutocompleteOptions {
  workspaceId?: string;
  threadId?: string;
  providerId?: string;
  cwd?: string;
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
    for (const listener of cacheInvalidationListeners) listener(key);
  } else {
    fileListCache.clear();
    for (const listener of cacheInvalidationListeners) listener();
  }
}

/**
 * Hook for @ file autocomplete in the Composer.
 *
 * Detects `@` triggers by scanning backward from the cursor, shows cached
 * selectable agents, lazy-loads workspace files, and reconciles the bounded
 * provider catalog while the picker stays open. Caches file lists per scope.
 */
export function useFileAutocomplete({
  workspaceId,
  threadId,
  providerId,
  cwd,
}: UseFileAutocompleteOptions): UseFileAutocompleteResult {
  const [isOpen, setIsOpen] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);
  const requestEpochRef = useRef(0);
  const refreshedAgentScopeRef = useRef<string | null>(null);
  const catalogRequest = useMemo<ProviderCatalogRequest | null>(() => (
    workspaceId && providerId === "codex"
      ? cwd
        ? { providerId: "codex", cwd }
        : { providerId: "codex", workspaceId, ...(threadId ? { threadId } : {}) }
      : null
  ), [cwd, workspaceId, threadId, providerId]);
  const catalogKey = catalogRequest ? providerCatalogCacheKey(catalogRequest) : "";
  const catalogSnapshot = useProviderCatalogStore((state) => (
    catalogKey ? state.entries[catalogKey]?.snapshot ?? null : null
  ));
  const catalogAgents = useMemo(
    () => (catalogSnapshot?.selectableAgents ?? []).map(toAgentSuggestion),
    [catalogSnapshot],
  );

  useEffect(() => {
    requestEpochRef.current += 1;
    refreshedAgentScopeRef.current = null;
    setSuggestions([]);
    setIsOpen(false);
  }, [catalogKey]);

  // Reset local state when scope changes so stale data isn't used.
  const prevScopeRef = useRef<string>("");
  useEffect(() => {
    const key = workspaceId ? scopeKey(workspaceId, threadId) : "";
    if (key !== prevScopeRef.current) {
      requestEpochRef.current += 1;
      refreshedAgentScopeRef.current = null;
      prevScopeRef.current = key;
      setAllFiles([]);
      setSuggestions([]);
      setIsOpen(false);
    }
  }, [workspaceId, threadId]);

  useEffect(() => {
    const listener = (invalidatedKey?: string) => {
      if (invalidatedKey && invalidatedKey !== prevScopeRef.current) return;
      requestEpochRef.current += 1;
      refreshedAgentScopeRef.current = null;
      setAllFiles([]);
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
        refreshedAgentScopeRef.current = null;
        setIsOpen(false);
        setSuggestions([]);
        setQuery("");
        setTriggerStart(-1);
        return;
      }

      const q = text.slice(atPos + 1, cursorPos).toLowerCase();
      setQuery(q);
      setTriggerStart(atPos);

      const cachedFiles = fileListCache.get(requestScope) ?? allFiles;
      setSuggestions(filterMentionSuggestions(cachedFiles, catalogAgents, q));
      setIsOpen(true);

      const shouldRefreshAgents = catalogRequest !== null
        && refreshedAgentScopeRef.current !== catalogKey;
      if (shouldRefreshAgents) refreshedAgentScopeRef.current = catalogKey;
      const [loadedFiles, loadedCatalog] = await Promise.all([
        allFiles.length === 0 ? loadFiles() : Promise.resolve(undefined),
        shouldRefreshAgents
          ? useProviderCatalogStore.getState().load(catalogRequest, true).catch((err) => {
              console.error("[useFileAutocomplete] Failed to load Codex agents:", err);
              return undefined;
            })
          : Promise.resolve(undefined),
      ]);
      const files = loadedFiles ?? cachedFiles;
      const agents = loadedCatalog
        ? loadedCatalog.selectableAgents.map(toAgentSuggestion)
        : catalogAgents;

      if (
        requestEpochRef.current !== requestEpoch ||
        prevScopeRef.current !== requestScope
      ) {
        return;
      }

      setSuggestions(filterMentionSuggestions(files, agents, q));
      setIsOpen(true);
    },
    [allFiles, catalogAgents, catalogKey, catalogRequest, loadFiles, threadId, workspaceId],
  );

  useEffect(() => {
    if (!isOpen) return;
    setSuggestions(filterMentionSuggestions(allFiles, catalogAgents, query));
  }, [allFiles, catalogAgents, isOpen, query]);

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
    refreshedAgentScopeRef.current = null;
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

function toAgentSuggestion(agent: SelectableProviderAgent): MentionSuggestion {
  return {
    id: `agent:${agent.providerId}:${agent.nativeId}`,
    kind: "agent",
    group: "Agents",
    label: agent.name,
    name: agent.name,
    path: agent.path,
    provider: "codex",
    ...(agent.description ? { description: agent.description } : {}),
  };
}

function filterMentionSuggestions(
  files: readonly string[],
  agents: readonly MentionSuggestion[],
  query: string,
): MentionSuggestion[] {
  const fileSuggestions: MentionSuggestion[] = files.map((filePath) => ({
    id: `file:${filePath}`,
    kind: "file",
    group: "Files",
    label: filePath,
    path: filePath,
  }));
  if (query.length === 0) {
    return [...agents.slice(0, 20), ...fileSuggestions.slice(0, 80)];
  }
  return [...agents, ...fileSuggestions].filter((suggestion) => {
    const haystack = suggestion.kind === "agent"
      ? `${suggestion.label} ${suggestion.description ?? ""}`.toLowerCase()
      : suggestion.path.toLowerCase();
    return haystack.includes(query);
  }).slice(0, 100);
}
