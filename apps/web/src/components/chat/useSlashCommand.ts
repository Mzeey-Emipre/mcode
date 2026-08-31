import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  EMPTY_PROVIDER_CATALOG_CACHE_ENTRY,
  providerCatalogCacheKey,
  useProviderCatalogStore,
} from "@/stores/providerCatalogStore";
import {
  ProviderIdSchema,
  type ProviderCapabilityEntry,
  type ProviderCapabilityKind,
  type ProviderCapabilityIdentity,
} from "@mcode/contracts";
import type { ProviderCatalogRequest } from "@/transport";
import type { SlashCommandNamespace } from "./lexical/SlashCommandNode";
import {
  resolveComposerCapabilities,
  type ComposerCapabilityAction,
} from "@/features/conversation/composer/composer-capabilities";

/** A slash command entry shown in the popup. */
export type ComposerCommandAction = ComposerCapabilityAction;

/** A slash command entry shown in the popup. */
export interface Command {
  id: string;
  name: string;
  description: string;
  namespace: SlashCommandNamespace;
  capabilityKind: ProviderCapabilityKind | "mcode";
  nativeId: string;
  mentionPath?: string;
  identity?: ProviderCapabilityIdentity;
  /** For mcode-namespace commands, the action string dispatched on selection. */
  action?: ComposerCommandAction;
}

/**
 * Render state of the slash command popup, modelled as a discriminated union
 * so the stale-while-revalidate priority (error → list → loading → empty) is an
 * exhaustive switch the compiler checks rather than a comment plus nested
 * ternary. `staleRevalidating` names the state behind the stuck-popup bug:
 * cached items are shown while a fresh skill load is still in flight.
 */
export type PopupState =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "ready"; items: Command[] }
  | { kind: "staleRevalidating"; items: Command[] }
  | { kind: "empty" }
  | { kind: "error"; error: Error };

const MAX_SLASH_COMMAND_ITEMS = 100;

const BUILTIN_COMMANDS: Command[] = [
  {
    id: "builtin:mcode:mcode-browser",
    name: "mcode-browser",
    description: "Read the Mcode Browser operating guide",
    namespace: "mcode",
    capabilityKind: "mcode",
    nativeId: "mcode-browser",
  },
  {
    id: "builtin:mcode:thread-control",
    name: "thread-control",
    description: "Read the Mcode thread-control operating guide",
    namespace: "mcode",
    capabilityKind: "mcode",
    nativeId: "thread-control",
  },
  {
    id: "builtin:command:compact",
    name: "compact",
    description: "Summarise conversation history to free up context window",
    namespace: "command",
    capabilityKind: "providerCommand",
    nativeId: "compact",
  },
];

/** Regex: matches `/` at start of line or after whitespace, followed by non-space chars. */
export const SLASH_TRIGGER_RE = /(^|\s)(\/\S*)$/;

/** Map an invocable provider capability into the existing command presentation. */
function toCommand(entry: ProviderCapabilityEntry): Command | null {
  const base = {
    id: `${entry.identity.providerId}:${entry.identity.kind}:${entry.identity.nativeId}`,
    name: entry.name,
    description: entry.description || `Run /${entry.name}`,
    capabilityKind: entry.kind,
    nativeId: entry.identity.nativeId,
    identity: entry.identity,
  };
  if (entry.kind === "plugin") {
    return {
      ...base,
      description: entry.description || `Use @${entry.name}`,
      namespace: "plugin",
      mentionPath: entry.mentionPath,
    };
  }
  if (entry.kind === "customPrompt" || entry.kind === "providerCommand") {
    return {
      ...base,
      namespace: "command",
    };
  }
  return {
    ...base,
    namespace: entry.source === "plugin" || entry.name.includes(":") ? "plugin" : "skill",
  };
}

function commandIdentity(command: Command): string {
  const identity = command.identity;
  return identity
    ? JSON.stringify([identity.providerId, identity.kind, identity.nativeId])
    : JSON.stringify(["mcode", command.namespace, command.name, command.action ?? null]);
}

function reconcileOpenCommands(current: Command[], refreshed: Command[]): Command[] {
  const refreshedByIdentity = new Map(
    refreshed.map((command) => [commandIdentity(command), command]),
  );
  const retained = current.flatMap((command) => {
    const updated = refreshedByIdentity.get(commandIdentity(command));
    return updated ? [updated] : [];
  });
  const retainedIdentities = new Set(retained.map(commandIdentity));
  const additions = refreshed.filter(
    (command) => !retainedIdentities.has(commandIdentity(command)),
  );
  return (["mcode", "command", "skill", "plugin"] as const).flatMap((namespace) => [
    ...retained.filter((command) => command.namespace === namespace),
    ...additions.filter((command) => command.namespace === namespace),
  ]);
}

/** Sort commands: source group order, then alphabetical within group. */
const NAMESPACE_ORDER: Record<SlashCommandNamespace, number> = {
  mcode: 0,
  command: 1,
  skill: 2,
  plugin: 3,
};

function sortCommands(cmds: Command[]): Command[] {
  return [...cmds].sort((a, b) => {
    const order = NAMESPACE_ORDER[a.namespace] - NAMESPACE_ORDER[b.namespace];
    if (order !== 0) return order;
    const nameOrder = a.name.localeCompare(b.name);
    return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id);
  });
}

/** Options for the useSlashCommand hook. */
interface UseSlashCommandOptions {
  anchorRef: React.RefObject<HTMLElement | null>;
  onMcodeCommand?: (action: ComposerCommandAction) => void;
  cwd?: string;
  /** Workspace whose validated server-side path scopes provider discovery. */
  workspaceId?: string;
  /** Thread whose worktree path scopes provider discovery. */
  threadId?: string;
  /** Provider ID used to scope skill loading and filter built-in commands (e.g., hides /plan for "copilot"). */
  providerId?: string;
  /** Model ID used to resolve model-specific composer capabilities. */
  modelId?: string;
  /**
   * Whether to include mcode built-in commands (plan, compact, goal, mcode-browser, thread-control) in the
   * command list. Default `true`. Pass `false` for contexts like the annotation
   * bubble where mcode actions are meaningless and must not be selectable.
   */
  includeBuiltins?: boolean;
  /** Whether this surface can persist native plugin mentions. */
  includePlugins?: boolean;
}

/** Return value of the useSlashCommand hook. */
export interface UseSlashCommandReturn {
  isOpen: boolean;
  /**
   * Typed render state for the popup. The popup switches on `state.kind`; the
   * priority that used to live in a comment now lives in this union. `items`
   * and `selectedIndex` remain on the return for the Composer's index-based
   * keyboard selection, which needs the flat list independent of render state.
   */
  state: PopupState;
  items: Command[];
  allCommands: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  /**
   * Notify the hook of a text change. Pass `cursorPos` for inputs where the
   * cursor may be mid-text (e.g. the annotation bubble `<input>`); when omitted
   * the hook defaults to end-of-string, matching the Composer's Lexical path.
   */
  onInputChange: (value: string, cursorPos?: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (cmd: Command, replaceText: (v: string) => void) => void;
  onDismiss: () => void;
  onRetry: () => void;
}

/** Manages slash command detection, provider catalog loading, and popup state. */
export function useSlashCommand({
  anchorRef,
  onMcodeCommand,
  cwd,
  workspaceId,
  threadId,
  providerId,
  modelId,
  includeBuiltins = true,
  includePlugins = true,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [filter, setFilter] = useState("");
  // The visible list is an interaction snapshot. Cache invalidations must not
  // reorder a picker while the user is navigating it with the keyboard.
  const [openCommands, setOpenCommands] = useState<Command[] | null>(null);
  const selectedCommandIdentityRef = useRef<string | null>(null);
  const lastInputRef = useRef("");
  // Tracks the cursor position supplied by the most recent onInputChange call
  // so onSelect can splice the replacement at the correct offset rather than
  // always appending to the end (which breaks mid-text trigger detection).
  const lastCursorRef = useRef<number | undefined>(undefined);

  const catalogRequest = useMemo<ProviderCatalogRequest | null>(() => {
    const parsedProvider = ProviderIdSchema.safeParse(providerId ?? "claude");
    if (!parsedProvider.success) return null;
    if (workspaceId) {
      return {
        providerId: parsedProvider.data,
        workspaceId,
        ...(threadId ? { threadId } : {}),
      };
    }
    return {
      providerId: parsedProvider.data,
      ...(cwd ? { cwd } : {}),
    };
  }, [cwd, providerId, threadId, workspaceId]);
  const cacheKey = catalogRequest ? providerCatalogCacheKey(catalogRequest) : "invalid-provider";
  const cacheEntry = useProviderCatalogStore(
    (state) => state.entries[cacheKey] ?? EMPTY_PROVIDER_CATALOG_CACHE_ENTRY,
  );
  const { snapshot, isLoading, needsRefresh, error } = cacheEntry;
  const load = useProviderCatalogStore((state) => state.load);

  // Build the full command list only when its inputs change. Filtering stays
  // separate so keyboard selection does not rebuild every command row.
  const allCommands = useMemo(() => {
    const builtins: Command[] = includeBuiltins
      ? [
          ...resolveComposerCapabilities({ providerId, modelId }).map(
            (capability): Command => ({
              id: `builtin:mcode:${capability.id}`,
              name: capability.slashCommand,
              description: `Attach ${capability.label} to the composer`,
              namespace: "mcode",
              capabilityKind: "mcode",
              nativeId: capability.id,
              action: capability.action,
            }),
          ),
          ...BUILTIN_COMMANDS,
        ]
      : [];
    const providerCommands = (snapshot?.entries ?? [])
      .filter((entry) => includePlugins || entry.kind !== "plugin")
      .map(toCommand)
      .filter((command): command is Command => command !== null);
    const commands: Command[] = [
      ...builtins,
      ...providerCommands,
    ];
    return sortCommands(commands);
  }, [snapshot, providerId, modelId, includeBuiltins, includePlugins]);

  const reconciledOpenCommands = useMemo(
    () => openCommands === null ? allCommands : reconcileOpenCommands(openCommands, allCommands),
    [allCommands, openCommands],
  );

  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    const matches = f
      ? reconciledOpenCommands.filter((c) => c.name.toLowerCase().includes(f))
      : reconciledOpenCommands;
    return matches.slice(0, MAX_SLASH_COMMAND_ITEMS);
  }, [filter, reconciledOpenCommands]);

  const displayedSelectedIndex = useMemo(() => {
    const selectedIdentity = selectedCommandIdentityRef.current;
    const retainedIndex = selectedIdentity
      ? filtered.findIndex((command) => commandIdentity(command) === selectedIdentity)
      : -1;
    if (retainedIndex >= 0) return retainedIndex;
    return filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);
  }, [filtered, selectedIndex]);

  useEffect(() => {
    selectedCommandIdentityRef.current = filtered[displayedSelectedIndex]
      ? commandIdentity(filtered[displayedSelectedIndex])
      : null;
  }, [displayedSelectedIndex, filtered]);

  // Derive the typed popup state. Order encodes the stale-while-revalidate
  // priority that previously lived in a comment in SlashCommandPopup:
  //   error → list (ready / staleRevalidating) → loading → empty.
  // The list branch splits on isLoading so a background refresh while cached
  // items are shown is the explicit `staleRevalidating` state, the one that
  // got stuck when invalidate() left isLoading=true.
  const state: PopupState = !isOpen
    ? { kind: "closed" }
    : error
      ? { kind: "error", error }
      : filtered.length > 0
        ? isLoading
          ? { kind: "staleRevalidating", items: filtered }
          : { kind: "ready", items: filtered }
        : isLoading
          ? { kind: "loading" }
          : { kind: "empty" };

  // Eager prefetch runs while the picker is closed. This warms the cache for
  // the next open without replacing commands while the user is navigating.
  //
  // Each provider discovery context has its own cache entry. Load when that entry
  // is cold or stale, while retaining old rows during background refresh.
  //
  // The error gate prevents an infinite retry loop on persistent failures.
  // A different context selects a different entry with its own error.
  useEffect(() => {
    if (isOpen) return;
    if (isLoading) return;
    const noSnapshot = snapshot === null;
    if (catalogRequest && !error && (needsRefresh || noSnapshot)) {
      load(catalogRequest).catch(() => { /* surfaced via `error` */ });
    }
  }, [catalogRequest, snapshot, isLoading, needsRefresh, error, load, isOpen]);

  const onInputChange = useCallback(
    (value: string, cursorPos?: number) => {
      lastInputRef.current = value;
      // Default to end-of-string when no cursor position is given, preserving
      // the Composer's Lexical path which always notifies with the full text.
      const cursor = cursorPos ?? value.length;
      lastCursorRef.current = cursor;
      const before = value.slice(0, cursor);
      const match = SLASH_TRIGGER_RE.exec(before);

      if (!match) {
        setIsOpen(false);
        setOpenCommands(null);
        selectedCommandIdentityRef.current = null;
        return;
      }

      const anchor = anchorRef.current;
      if (anchor) setAnchorRect(anchor.getBoundingClientRect());

      if (!isOpen) {
        if (snapshot !== null) setOpenCommands(allCommands);
        if (providerId === "codex" && catalogRequest) {
          load(catalogRequest, true).catch(() => { /* surfaced via `error` */ });
        }
      }
      setFilter(match[2].slice(1));
      setIsOpen(true);
      setSelectedIndex(0);
      selectedCommandIdentityRef.current = null;
    },
    [anchorRef, allCommands, catalogRequest, isOpen, load, providerId, snapshot],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          e.stopPropagation();
          // Clamp to 0 when filtered is empty; otherwise `length - 1` would
          // be `-1`, leaking an invalid index into ARIA / keyboard handling.
          const nextIndex = filtered.length === 0
            ? 0
            : Math.min(displayedSelectedIndex + 1, filtered.length - 1);
          selectedCommandIdentityRef.current = filtered[nextIndex]
            ? commandIdentity(filtered[nextIndex])
            : null;
          setSelectedIndex(nextIndex);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          e.stopPropagation();
          const previousIndex = Math.max(displayedSelectedIndex - 1, 0);
          selectedCommandIdentityRef.current = filtered[previousIndex]
            ? commandIdentity(filtered[previousIndex])
            : null;
          setSelectedIndex(previousIndex);
          break;
        }
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(false);
          setOpenCommands(null);
          selectedCommandIdentityRef.current = null;
          break;
      }
    },
    [displayedSelectedIndex, filtered, isOpen],
  );

  const onSelect = useCallback(
    (cmd: Command, replaceText: (v: string) => void) => {
      const value = lastInputRef.current;
      // Use the stored cursor position from the last onInputChange so that
      // mid-text replacements splice at the right offset. Falls back to
      // end-of-string for the Composer's Lexical path which never sets it.
      const cursor = lastCursorRef.current ?? value.length;
      const before = value.slice(0, cursor);
      const match = SLASH_TRIGGER_RE.exec(before);

      if (match) {
        // Use match.index + leading group length to anchor to the exact regex match
        // position, rather than lastIndexOf which can pick the wrong occurrence
        // when the same trigger text appears multiple times before the cursor.
        const triggerStart = match.index + match[1].length;
        replaceText(
          cmd.action
            ? value.slice(0, triggerStart) + value.slice(cursor)
            : value.slice(0, triggerStart) + (
                cmd.capabilityKind === "plugin" ? `@${cmd.name} ` : `/${cmd.name} `
              ) + value.slice(cursor),
        );
      }
      if (cmd.action && onMcodeCommand) onMcodeCommand(cmd.action);
      setIsOpen(false);
      setOpenCommands(null);
      selectedCommandIdentityRef.current = null;
    },
    [onMcodeCommand],
  );

  const onDismiss = useCallback(() => {
    setIsOpen(false);
    setOpenCommands(null);
    selectedCommandIdentityRef.current = null;
  }, []);
  const onRetry = useCallback(() => {
    if (!catalogRequest) return;
    load(catalogRequest, true).catch(() => { /* surfaced via `error` */ });
  }, [catalogRequest, load]);

  return {
    isOpen,
    state,
    items: filtered,
    allCommands,
    selectedIndex: displayedSelectedIndex,
    anchorRect,
    onInputChange,
    onKeyDown,
    onSelect,
    onDismiss,
    onRetry,
  };
}
