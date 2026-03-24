import type { LucideIcon } from "lucide-react";
import {
  Bot, FileText, FilePen, FolderSearch, Globe,
  Pencil, Search, Terminal, Wrench,
} from "lucide-react";

export const TOOL_LABELS: Record<string, string> = {
  Glob: "Listed directory",
  Read: "Read file",
  Edit: "Edited file",
  Write: "Created file",
  Bash: "Ran command",
  Grep: "Searched files",
  Agent: "Delegated task",
  WebSearch: "Searched web",
  WebFetch: "Fetched page",
};

export const TOOL_ICONS: Record<string, LucideIcon> = {
  Glob: FolderSearch,
  Grep: Search,
  Read: FileText,
  Write: FilePen,
  Edit: Pencil,
  Bash: Terminal,
  Agent: Bot,
  WebSearch: Globe,
  WebFetch: Globe,
};

export const DEFAULT_ICON = Wrench;

/** Present-tense phase labels shown in the streaming indicator. */
export const TOOL_PHASE_LABELS: Record<string, string> = {
  Glob: "Searching the codebase...",
  Grep: "Searching the codebase...",
  Read: "Reading files...",
  Edit: "Making changes...",
  Write: "Making changes...",
  Bash: "Running a command...",
  Agent: "Thinking deeper...",
  WebSearch: "Searching the web...",
  WebFetch: "Fetching a page...",
};
