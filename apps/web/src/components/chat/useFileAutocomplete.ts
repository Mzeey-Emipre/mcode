import { useState, useRef, useCallback, useEffect, useMemo, type MutableRefObject } from "react";
import { getTransport } from "@/transport";
import {
  providerCatalogCacheKey,
  useProviderCatalogStore,
} from "@/stores/providerCatalogStore";
import type {
  ProviderCatalogRequest,
  ProviderPluginCapability,
  SelectableProviderAgent,
} from "@mcode/contracts";

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
    }
  | {
      id: string;
      kind: "plugin";
      group: "Plugins";
      label: string;
      name: string;
      path: string;
      description?: string;
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

interface MentionTrigger {
  readonly query: string;
  readonly start: number;
}

interface ScopedFileList {
  readonly scopeKey: string;
  readonly files: string[];
}

/** Build a composite cache key from workspace + thread scope. */
function scopeKey(workspaceId: string, threadId?: string): string {
  return threadId ? `${workspaceId}:${threadId}` : workspaceId;
}

/** Returns the active @ trigger before the Composer cursor. */
function findMentionTrigger(text: string, cursorPos: number): MentionTrigger | null {
  for (let index = cursorPos - 1; index >= 0; index -= 1) {
    const character = text[index];
    if (character === "@") {
      if (index === 0 || /\s/.test(text[index - 1])) {
        return { start: index, query: text.slice(index + 1, cursorPos).toLowerCase() };
      }
      return null;
    }
    if (/\s/.test(character)) return null;
  }
  return null;
}

/** Marks a provider catalog scope for one picker-open refresh. */
function claimCatalogRefresh(
  request: ProviderCatalogRequest | null,
  catalogKey: string,
  refreshedScopeRef: MutableRefObject<string | null>,
): boolean {
  if (request === null || refreshedScopeRef.current === catalogKey) return false;
  refreshedScopeRef.current = catalogKey;
  return true;
}

/** Loads missing file and provider catalog data for an open mention picker. */
async function loadMentionResources({
  allFiles,
  loadFiles,
  shouldRefreshCatalog,
  catalogRequest,
}: {
  allFiles: readonly string[];
  loadFiles: () => Promise<string[] | undefined>;
  shouldRefreshCatalog: boolean;
  catalogRequest: ProviderCatalogRequest | null;
}): Promise<void> {
  const filesPromise = allFiles.length === 0 ? loadFiles() : Promise.resolve(undefined);
  const catalogPromise = shouldRefreshCatalog && catalogRequest
    ? useProviderCatalogStore.getState().load(catalogRequest, true).catch((err) => {
        console.error("[useFileAutocomplete] Failed to load Codex agents:", err);
        return undefined;
      })
    : Promise.resolve(undefined);
  await Promise.all([filesPromise, catalogPromise]);
}

/** Cache file list per scope (workspace + thread) to avoid repeated IPC calls. */
const fileListCache = new Map<string, string[]>();

/** In-flight fetch promises keyed by scope, so concurrent callers reuse the same request. */
const inFlightFetches = new Map<string, Promise<string[]>>();

/** Mounted hooks that must discard local data after a cache invalidation. */
const cacheInvalidationListeners = new Set<(key?: string) => void>();
const EMPTY_FILE_LIST: readonly string[] = [];
const EMPTY_SUGGESTIONS: MentionSuggestion[] = [];

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
  const [fileList, setFileList] = useState<ScopedFileList>({ scopeKey: "", files: [] });
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);
  const requestEpochRef = useRef(0);
  const refreshedAgentScopeRef = useRef<string | null>(null);
  const currentScopeKey = workspaceId ? scopeKey(workspaceId, threadId) : "";
  const allFiles = fileList.scopeKey === currentScopeKey ? fileList.files : EMPTY_FILE_LIST;
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
  const catalogPlugins = useMemo(
    () => (catalogSnapshot?.entries ?? [])
      .filter((entry): entry is ProviderPluginCapability => entry.kind === "plugin")
      .map(toPluginSuggestion),
    [catalogSnapshot],
  );

  useEffect(() => {
    requestEpochRef.current += 1;
    refreshedAgentScopeRef.current = null;
    // oxlint-disable-next-line react/set-state-in-effect -- A provider catalog switch must close the picker before it can expose entries from a different provider scope.
    setIsOpen(false);
  }, [catalogKey]);

  // Reset the request lifecycle when scope changes; render ignores the prior scope's file list.
  const prevScopeRef = useRef<string>("");
  useEffect(() => {
    if (currentScopeKey !== prevScopeRef.current) {
      requestEpochRef.current += 1;
      refreshedAgentScopeRef.current = null;
      prevScopeRef.current = currentScopeKey;
      setIsOpen(false);
    }
  }, [currentScopeKey]);

  const loadFiles = useCallback(async (): Promise<string[] | undefined> => {
    if (!workspaceId) return;

    const key = scopeKey(workspaceId, threadId);

    // Return from cache if available.
    const cached = fileListCache.get(key);
    if (cached) {
      setFileList({ scopeKey: key, files: cached });
      return cached;
    }

    // Reuse an in-flight fetch for the same scope instead of starting a new one.
    const existing = inFlightFetches.get(key);
    if (existing) {
      const files = await existing;
      setFileList({ scopeKey: key, files });
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
      setFileList({ scopeKey: key, files });
    }
    return files;
  }, [workspaceId, threadId]);

  useEffect(() => {
    const listener = (invalidatedKey?: string) => {
      if (invalidatedKey && invalidatedKey !== prevScopeRef.current) return;
      requestEpochRef.current += 1;
      refreshedAgentScopeRef.current = null;
      setFileList({ scopeKey: prevScopeRef.current, files: [] });
      if (isOpen) void loadFiles();
    };
    cacheInvalidationListeners.add(listener);
    return () => {
      requestEpochRef.current += 1;
      cacheInvalidationListeners.delete(listener);
    };
  }, [isOpen, loadFiles]);

  const dismiss = useCallback(() => {
    requestEpochRef.current += 1;
    refreshedAgentScopeRef.current = null;
    setIsOpen(false);
    setQuery("");
    setTriggerStart(-1);
  }, []);

  const handleInputChange = useCallback(
    async (text: string, cursorPos: number) => {
      const requestEpoch = ++requestEpochRef.current;
      const requestScope = workspaceId ? scopeKey(workspaceId, threadId) : "";
      const trigger = findMentionTrigger(text, cursorPos);
      if (!trigger) {
        dismiss();
        return;
      }

      setQuery(trigger.query);
      setTriggerStart(trigger.start);

      setIsOpen(true);

      const shouldRefreshCatalog = claimCatalogRefresh(
        catalogRequest,
        catalogKey,
        refreshedAgentScopeRef,
      );
      await loadMentionResources({
        allFiles,
        loadFiles,
        shouldRefreshCatalog,
        catalogRequest,
      });
      if (
        requestEpochRef.current !== requestEpoch ||
        prevScopeRef.current !== requestScope
      ) {
        return;
      }

      setIsOpen(true);
    },
    [allFiles, catalogKey, catalogRequest, dismiss, loadFiles, threadId, workspaceId],
  );

  const suggestions = useMemo(
    () => (
      isOpen
        ? filterMentionSuggestions(allFiles, catalogAgents, catalogPlugins, query)
        : EMPTY_SUGGESTIONS
    ),
    [allFiles, catalogAgents, catalogPlugins, isOpen, query],
  );

  const selectSuggestion = useCallback((suggestion: MentionSuggestion): MentionSuggestion => {
    requestEpochRef.current += 1;
    setIsOpen(false);
    setQuery("");
    setTriggerStart(-1);
    return suggestion;
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

function toPluginSuggestion(plugin: ProviderPluginCapability): MentionSuggestion {
  return {
    id: `plugin:${plugin.identity.providerId}:${plugin.identity.nativeId}`,
    kind: "plugin",
    group: "Plugins",
    label: plugin.name,
    name: plugin.name,
    path: plugin.mentionPath,
    ...(plugin.description ? { description: plugin.description } : {}),
  };
}

function filterMentionSuggestions(
  files: readonly string[],
  agents: readonly MentionSuggestion[],
  plugins: readonly MentionSuggestion[],
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
    return [...agents.slice(0, 20), ...plugins.slice(0, 20), ...fileSuggestions.slice(0, 80)];
  }
  return [...agents, ...plugins, ...fileSuggestions].filter((suggestion) => {
    const haystack = suggestion.kind === "agent" || suggestion.kind === "plugin"
      ? `${suggestion.label} ${suggestion.description ?? ""}`.toLowerCase()
      : suggestion.path.toLowerCase();
    return haystack.includes(query);
  }).slice(0, 100);
}
