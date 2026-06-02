import { useState, useRef, useCallback, useEffect } from "react";
import { useSkillsStore } from "@/stores/skillsStore";
import type { SkillInfo } from "@/transport";
import type { SlashCommandNamespace } from "./lexical/SlashCommandNode";

/** A slash command entry shown in the popup. */
export interface Command {
  name: string;
  description: string;
  namespace: SlashCommandNamespace;
  /** For mcode-namespace commands, the action string dispatched on selection. */
  action?: string;
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

const BUILTIN_COMMANDS: Command[] = [
  { name: "m:plan", description: "Toggle plan mode", namespace: "mcode", action: "toggle-plan" },
  { name: "compact", description: "Summarise conversation history to free up context window", namespace: "command" },
  { name: "goal", description: "Set a goal the agent must satisfy before stopping (\"/goal clear\" to remove)", namespace: "command" },
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
    namespace: s.name.includes(":") ? "plugin" : "skill",
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
  onMcodeCommand?: (action: string) => void;
  cwd?: string;
  /** Provider ID used to scope skill loading and filter built-in commands (e.g., hides /m:plan for "copilot"). */
  providerId?: string;
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
  onInputChange: (value: string) => void;
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
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const lastInputRef = useRef("");
  const lastFilterRef = useRef("");

  const skills = useSkillsStore((s) => s.skills);
  const cachedCwd = useSkillsStore((s) => s.cwd);
  const cachedProviderId = useSkillsStore((s) => s.providerId);
  const isLoading = useSkillsStore((s) => s.isLoading);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);

  // Build the full command list (memoize via skills identity and providerId).
  // The filter is inside the callback so `providerId` (a stable string) is the
  // dep — if we filtered outside and put the resulting array in deps, every
  // render would produce a new reference and break memoization.
  const allCommands = useCallback(() => {
    const builtins = BUILTIN_COMMANDS.filter((cmd) => {
      // /m:plan is hidden for copilot (uses its own dynamic modes instead)
      if (cmd.name === "m:plan" && providerId === "copilot") return false;
      // /goal is implemented in the Claude provider's Stop hook; hide on others.
      if (cmd.name === "goal" && providerId !== "claude") return false;
      return true;
    });
    const commands: Command[] = [
      ...builtins,
      ...((skills ?? []).map(toCommand)),
    ];
    return sortCommands(commands);
  }, [skills, providerId])();

  const filtered = (() => {
    const f = lastFilterRef.current.toLowerCase();
    if (!f) return allCommands;
    return allCommands.filter((c) => c.name.toLowerCase().includes(f));
  })();

  // Derive the typed popup state. Order encodes the stale-while-revalidate
  // priority that previously lived in a comment in SlashCommandPopup:
  //   error → list (ready / staleRevalidating) → loading → empty.
  // The list branch splits on isLoading so a background refresh while cached
  // items are shown is the explicit `staleRevalidating` state — the one that
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

  // Eager prefetch: load skills as soon as cwd/providerId are known, NOT
  // when the popup opens. This ensures the cache is warm by the time the
  // user types `/`, so the popup renders the full list on first paint and
  // the loading skeleton is never visible.
  //
  // Conditions to trigger a load:
  //   - cwd differs from the cached cwd (workspace switch)
  //   - providerId differs (provider switch)
  //   - skills are null and no prior error (cold start)
  //
  // The `!error` gate prevents an infinite retry loop on persistent
  // failures: when cwd is unchanged, recovery happens via `onRetry`.
  // When cwd changes, we always load (treating it as a fresh workspace,
  // ignoring any prior error from the old one).
  useEffect(() => {
    if (isLoading) return;
    const cwdChanged = cachedCwd !== cwd;
    const providerChanged = cachedProviderId !== providerId;
    const noSkills = skills === null;
    if (cwdChanged || providerChanged || (noSkills && !error)) {
      load(cwd, providerId).catch(() => { /* surfaced via `error` */ });
    }
  }, [skills, cachedCwd, cachedProviderId, cwd, providerId, isLoading, error, load]);

  const onInputChange = useCallback(
    (value: string) => {
      lastInputRef.current = value;
      const cursor = value.length;
      const before = value.slice(0, cursor);
      const match = SLASH_TRIGGER_RE.exec(before);

      if (!match) {
        setIsOpen(false);
        return;
      }

      const anchor = anchorRef.current;
      if (anchor) setAnchorRect(anchor.getBoundingClientRect());

      lastFilterRef.current = match[2].slice(1);
      setIsOpen(true);
      setSelectedIndex(0);
    },
    [anchorRef],
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
          break;
      }
    },
    [isOpen, filtered.length],
  );

  const onSelect = useCallback(
    (cmd: Command, replaceText: (v: string) => void) => {
      const value = lastInputRef.current;
      const cursor = value.length;
      const before = value.slice(0, cursor);
      const match = SLASH_TRIGGER_RE.exec(before);

      if (match) {
        // Use match.index + leading group length to anchor to the exact regex match
        // position, rather than lastIndexOf which can pick the wrong occurrence
        // when the same trigger text appears multiple times before the cursor.
        const triggerStart = match.index + match[1].length;
        replaceText(value.slice(0, triggerStart) + `/${cmd.name} ` + value.slice(cursor));
      }
      if (cmd.action && onMcodeCommand) onMcodeCommand(cmd.action);
      setIsOpen(false);
    },
    [onMcodeCommand],
  );

  const onDismiss = useCallback(() => setIsOpen(false), []);
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
