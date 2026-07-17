import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  EMPTY_SKILLS_CACHE_ENTRY,
  skillsCacheKey,
  useSkillsStore,
} from "@/stores/skillsStore";
import type { SkillInfo } from "@/transport";
import type { SlashCommandNamespace } from "./lexical/SlashCommandNode";
import {
  resolveComposerCapabilities,
  type ComposerCapabilityAction,
} from "./composer-capabilities";

/** A slash command entry shown in the popup. */
export type ComposerCommandAction = ComposerCapabilityAction;

/** A slash command entry shown in the popup. */
export interface Command {
  name: string;
  description: string;
  namespace: SlashCommandNamespace;
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
    name: "compact",
    description: "Summarise conversation history to free up context window",
    namespace: "command",
  },
];

/** Regex: matches `/` at start of line or after whitespace, followed by non-space chars. */
export const SLASH_TRIGGER_RE = /(^|\s)(\/\S*)$/;

/** Map a SkillInfo into a Command. */
function toCommand(s: SkillInfo): Command {
  // `kind === "command"` overrides any namespace inference.
  if (s.kind === "command") {
    return { name: s.name, description: s.description || `Run /${s.name}`, namespace: "command" };
  }
  return {
    name: s.name,
    description: s.description || `Run /${s.name}`,
    namespace: s.source === "plugin" || s.name.includes(":") ? "plugin" : "skill",
  };
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
    return order !== 0 ? order : a.name.localeCompare(b.name);
  });
}

/** Options for the useSlashCommand hook. */
interface UseSlashCommandOptions {
  anchorRef: React.RefObject<HTMLElement | null>;
  onMcodeCommand?: (action: ComposerCommandAction) => void;
  cwd?: string;
  /** Provider ID used to scope skill loading and filter built-in commands (e.g., hides /plan for "copilot"). */
  providerId?: string;
  /** Model ID used to resolve model-specific composer capabilities. */
  modelId?: string;
  /**
   * Whether to include mcode built-in commands (plan, compact, goal) in the
   * command list. Default `true`. Pass `false` for contexts like the annotation
   * bubble where mcode actions are meaningless and must not be selectable.
   */
  includeBuiltins?: boolean;
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

/** Manages slash command detection, skill loading via skillsStore, and popup state. */
export function useSlashCommand({
  anchorRef,
  onMcodeCommand,
  cwd,
  providerId,
  modelId,
  includeBuiltins = true,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [filter, setFilter] = useState("");
  // The visible list is an interaction snapshot. Cache invalidations must not
  // reorder a picker while the user is navigating it with the keyboard.
  const [openCommands, setOpenCommands] = useState<Command[] | null>(null);
  const lastInputRef = useRef("");
  // Tracks the cursor position supplied by the most recent onInputChange call
  // so onSelect can splice the replacement at the correct offset rather than
  // always appending to the end (which breaks mid-text trigger detection).
  const lastCursorRef = useRef<number | undefined>(undefined);

  const cacheKey = skillsCacheKey(cwd, providerId);
  const cacheEntry = useSkillsStore(
    (state) => state.entries[cacheKey] ?? EMPTY_SKILLS_CACHE_ENTRY,
  );
  const { skills, isLoading, isStale, error } = cacheEntry;
  const load = useSkillsStore((s) => s.load);

  // Build the full command list only when its inputs change. Filtering stays
  // separate so keyboard selection does not rebuild every command row.
  const allCommands = useMemo(() => {
    const builtins: Command[] = includeBuiltins
      ? [
          ...resolveComposerCapabilities({ providerId, modelId }).map(
            (capability): Command => ({
              name: capability.slashCommand,
              description: `Attach ${capability.label} to the composer`,
              namespace: "mcode",
              action: capability.action,
            }),
          ),
          ...BUILTIN_COMMANDS,
        ]
      : [];
    const commands: Command[] = [
      ...builtins,
      ...((skills ?? []).map(toCommand)),
    ];
    return sortCommands(commands);
  }, [skills, providerId, modelId, includeBuiltins]);

  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    const matches = f
      ? (openCommands ?? allCommands).filter((c) => c.name.toLowerCase().includes(f))
      : (openCommands ?? allCommands);
    return matches.slice(0, MAX_SLASH_COMMAND_ITEMS);
  }, [allCommands, filter, openCommands]);

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
  // Each cwd and provider pair has its own cache entry. Load when that entry
  // is cold or stale, while retaining old rows during background refresh.
  //
  // The error gate prevents an infinite retry loop on persistent failures.
  // A different cwd or provider selects a different entry with its own error.
  useEffect(() => {
    if (isOpen) return;
    if (isLoading) return;
    const noSkills = skills === null;
    if (!error && (isStale || noSkills)) {
      load(cwd, providerId).catch(() => { /* surfaced via `error` */ });
    }
  }, [skills, cwd, providerId, isLoading, isStale, error, load, isOpen]);

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
        return;
      }

      const anchor = anchorRef.current;
      if (anchor) setAnchorRect(anchor.getBoundingClientRect());

      if (!isOpen && skills !== null) setOpenCommands(allCommands);
      setFilter(match[2].slice(1));
      setIsOpen(true);
      setSelectedIndex(0);
    },
    [anchorRef, allCommands, isOpen, skills],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          // Clamp to 0 when filtered is empty; otherwise `length - 1` would
          // be `-1`, leaking an invalid index into ARIA / keyboard handling.
          setSelectedIndex((i) =>
            filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1),
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(false);
          setOpenCommands(null);
          break;
      }
    },
    [isOpen, filtered.length],
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
            : value.slice(0, triggerStart) + `/${cmd.name} ` + value.slice(cursor),
        );
      }
      if (cmd.action && onMcodeCommand) onMcodeCommand(cmd.action);
      setIsOpen(false);
      setOpenCommands(null);
    },
    [onMcodeCommand],
  );

  const onDismiss = useCallback(() => {
    setIsOpen(false);
    setOpenCommands(null);
  }, []);
  const onRetry = useCallback(() => {
    load(cwd, providerId, true).catch(() => { /* surfaced via `error` */ });
  }, [load, cwd, providerId]);

  return {
    isOpen,
    state,
    items: filtered,
    allCommands,
    selectedIndex,
    anchorRect,
    onInputChange,
    onKeyDown,
    onSelect,
    onDismiss,
    onRetry,
  };
}
