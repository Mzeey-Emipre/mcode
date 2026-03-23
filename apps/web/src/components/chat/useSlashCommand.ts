import { useState, useRef, useCallback } from "react";
import { getTransport, type SkillInfo } from "@/transport";

export interface Command {
  name: string;
  description: string;
  namespace: "skill" | "mcode";
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
const TRIGGER_RE = /(^|\s)(\/\S*)$/;

const CACHE_TTL_MS = 5 * 60 * 1000;

interface UseSlashCommandOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onMcodeCommand?: (action: string) => void;
}

export interface UseSlashCommandReturn {
  isOpen: boolean;
  isLoading: boolean;
  items: Command[];
  selectedIndex: number;
  anchorRect: DOMRect | null;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect: (cmd: Command, setInput: (v: string) => void) => void;
  onDismiss: () => void;
}

export function useSlashCommand({
  textareaRef,
  onMcodeCommand,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [items, setItems] = useState<Command[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Cache: loaded skills + timestamp for TTL
  const skillsCache = useRef<{ skills: SkillInfo[]; fetchedAt: number } | null>(null);

  const loadSkills = useCallback(async (): Promise<SkillInfo[]> => {
    const now = Date.now();
    if (skillsCache.current && now - skillsCache.current.fetchedAt < CACHE_TTL_MS) {
      return skillsCache.current.skills;
    }
    const skills = await getTransport().listSkills();
    skillsCache.current = { skills, fetchedAt: now };
    return skills;
  }, []);

  const buildItems = useCallback((skillInfos: SkillInfo[], filter: string): Command[] => {
    const f = filter.toLowerCase();
    const skills: Command[] = skillInfos.map(({ name, description }) => ({
      name,
      description: description || `Run /${name}`,
      namespace: "skill" as const,
    }));
    const all = [...MCODE_COMMANDS, ...skills];
    if (!f) return all;
    return all.filter((cmd) => cmd.name.toLowerCase().includes(f));
  }, []);

  const onInputChange = useCallback(
    (value: string) => {
      const textarea = textareaRef.current;
      const cursor = textarea?.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const match = TRIGGER_RE.exec(before);

      if (!match) {
        setIsOpen(false);
        return;
      }

      // Update anchor on every change while popup is open
      if (textarea) {
        setAnchorRect(textarea.getBoundingClientRect());
      }

      // Filter text is the matched group minus the leading '/'
      const triggerText = match[2]; // e.g. "/com"
      const filter = triggerText.slice(1); // e.g. "com"

      setIsOpen(true);
      setSelectedIndex(0);

      if (!skillsCache.current) {
        setIsLoading(true);
        let cancelled = false;
        loadSkills()
          .then((skills) => {
            if (!cancelled) {
              setIsLoading(false);
              setItems(buildItems(skills, filter));
            }
          })
          .catch(() => {
            if (!cancelled) setIsLoading(false);
          });
        return () => { cancelled = true; };
      } else {
        setItems(buildItems(skillsCache.current.skills, filter));
        // Background refresh if TTL expired
        if (Date.now() - skillsCache.current.fetchedAt >= CACHE_TTL_MS) {
          let cancelled = false;
          loadSkills()
            .then((skills) => {
              if (!cancelled) setItems(buildItems(skills, filter));
            })
            .catch(() => {
              // Background refresh failed silently; existing cache remains
            });
          return () => { cancelled = true; };
        }
      }
    },
    [textareaRef, loadSkills, buildItems],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    (cmd: Command, setInput: (v: string) => void) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const value = textarea.value;
      const cursor = textarea.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const match = TRIGGER_RE.exec(before);

      if (match) {
        // Use match.index + leading group length to anchor to the exact regex match
        // position, rather than lastIndexOf which can pick the wrong occurrence
        // when the same trigger text appears multiple times before the cursor.
        const triggerStart = match.index + match[1].length;
        const newValue =
          value.slice(0, triggerStart) + `/${cmd.name} ` + value.slice(cursor);
        setInput(newValue);
      }

      if (cmd.action && onMcodeCommand) {
        onMcodeCommand(cmd.action);
      }

      setIsOpen(false);
    },
    [textareaRef, onMcodeCommand],
  );

  const onDismiss = useCallback(() => setIsOpen(false), []);

  return {
    isOpen,
    isLoading,
    items,
    selectedIndex,
    anchorRect,
    onInputChange,
    onKeyDown,
    onSelect,
    onDismiss,
  };
}
