import { useState, useRef, useCallback } from "react";
import { getTransport, type SkillInfo } from "@/transport";

/** A slash command entry shown in the popup. */
export interface Command {
  name: string;
  description: string;
  namespace: "skill" | "mcode" | "plugin";
  /** For mcode-namespace commands, the action string dispatched on selection. */
  action?: string;
}

const MCODE_COMMANDS: Command[] = [
  {
    name: "m:plan",
    description: "Toggle plan mode",
    namespace: "mcode",
    action: "toggle-plan",
  },
];

/** Regex: matches `/` at start of line or after whitespace, followed by non-space chars. */
export const SLASH_TRIGGER_RE = /(^|\s)(\/\S*)$/;

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Options for the useSlashCommand hook. */
interface UseSlashCommandOptions {
  anchorRef: React.RefObject<HTMLElement | null>;
  onMcodeCommand?: (action: string) => void;
  cwd?: string;
}

/** Return value of the useSlashCommand hook. */
export interface UseSlashCommandReturn {
  isOpen: boolean;
  isLoading: boolean;
  items: Command[];
  allCommands: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (cmd: Command, replaceText: (v: string) => void) => void;
  onDismiss: () => void;
}

/** Manages slash command detection, skill loading, and popup state. */
export function useSlashCommand({
  anchorRef,
  onMcodeCommand,
  cwd,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [items, setItems] = useState<Command[]>([]);
  const [allCommands, setAllCommands] = useState<Command[]>(MCODE_COMMANDS);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Store the last input text so onSelect can read it without a textarea ref.
  const lastInputRef = useRef("");

  // Abort controller for cancelling stale skill-loading requests
  const abortRef = useRef<AbortController | null>(null);

  // Cache: loaded skills + timestamp for TTL.
  // Also track which cwd the cache was built for — invalidate on workspace switch.
  const skillsCache = useRef<{ skills: SkillInfo[]; fetchedAt: number; cwd?: string } | null>(null);

  const buildItems = useCallback((skillInfos: SkillInfo[], filter: string): Command[] => {
    const f = filter.toLowerCase();
    const skills: Command[] = skillInfos.map(({ name, description }) => ({
      name,
      description: description || `Run /${name}`,
      namespace: (name.includes(":") ? "plugin" : "skill") as "plugin" | "skill",
    }));
    const all = [...MCODE_COMMANDS, ...skills];
    if (!f) return all;
    return all.filter((cmd) => cmd.name.toLowerCase().includes(f));
  }, []);

  const loadSkills = useCallback(async (): Promise<SkillInfo[]> => {
    const now = Date.now();
    const cached = skillsCache.current;
    if (cached && cached.cwd === cwd && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.skills;
    }
    const skills = await getTransport().listSkills(cwd);
    skillsCache.current = { skills, fetchedAt: now, cwd };
    setAllCommands(buildItems(skills, ""));
    return skills;
  }, [cwd, buildItems]);

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

      // Update anchor on every change while popup is open
      const anchor = anchorRef.current;
      if (anchor) {
        setAnchorRect(anchor.getBoundingClientRect());
      }

      // Filter text is the matched group minus the leading '/'
      const triggerText = match[2]; // e.g. "/com"
      const filter = triggerText.slice(1); // e.g. "com"

      setIsOpen(true);
      setSelectedIndex(0);

      // Abort any previous in-flight skill load
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (!skillsCache.current) {
        setIsLoading(true);
        loadSkills()
          .then((skills) => {
            if (!controller.signal.aborted) {
              setIsLoading(false);
              setItems(buildItems(skills, filter));
            }
          })
          .catch(() => {
            if (!controller.signal.aborted) setIsLoading(false);
          });
      } else {
        setItems(buildItems(skillsCache.current.skills, filter));
        // Background refresh if TTL expired
        if (Date.now() - skillsCache.current.fetchedAt >= CACHE_TTL_MS) {
          loadSkills()
            .then((skills) => {
              if (!controller.signal.aborted) setItems(buildItems(skills, filter));
            })
            .catch(() => {
              // Background refresh failed silently; existing cache remains
            });
        }
      }
    },
    [anchorRef, loadSkills, buildItems],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;

      // Enter and Tab are handled by the Composer (it calls onSelect directly).
      // The hook handles only navigation and dismiss.
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
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
    [isOpen, items],
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
        const newValue =
          value.slice(0, triggerStart) + `/${cmd.name} ` + value.slice(cursor);
        replaceText(newValue);
      }

      if (cmd.action && onMcodeCommand) {
        onMcodeCommand(cmd.action);
      }

      setIsOpen(false);
    },
    [onMcodeCommand],
  );

  const onDismiss = useCallback(() => setIsOpen(false), []);

  return {
    isOpen,
    isLoading,
    items,
    allCommands,
    selectedIndex,
    anchorRect,
    onInputChange,
    onKeyDown,
    onSelect,
    onDismiss,
  };
}
