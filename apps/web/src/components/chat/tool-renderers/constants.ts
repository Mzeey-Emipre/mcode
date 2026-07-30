import type { LucideIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  FileText, FilePen, FolderSearch, Globe,
  Pencil, Search, Terminal, Wrench,
} from "lucide-react";
import { StackedLayersIcon } from "../narrative/StackedLayersIcon";

/** Accepts both Lucide icons and plain SVG function components. */
export type IconComponent = LucideIcon | ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

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
  browser_status: "Checked Browser",
  browser_open: "Opened page",
  browser_navigate: "Navigated page",
  browser_resize: "Resized Browser",
  browser_snapshot: "Inspected page",
  browser_screenshot: "Captured page",
  browser_click: "Clicked page",
  browser_type: "Typed in page",
  browser_press: "Pressed key in page",
  browser_scroll: "Scrolled page",
  browser_wait_for: "Waited for page",
  browser_console: "Inspected console",
  browser_network: "Inspected network",
  browser_accessibility: "Inspected accessibility",
  browser_performance: "Audited page performance",
  browser_evaluate: "Evaluated page",
  browser_recording_start: "Started page recording",
  browser_recording_stop: "Stopped page recording",
};

export const TOOL_ICONS: Record<string, IconComponent> = {
  Glob: FolderSearch,
  Grep: Search,
  Read: FileText,
  Write: FilePen,
  Edit: Pencil,
  Bash: Terminal,
  Agent: StackedLayersIcon,
  WebSearch: Globe,
  WebFetch: Globe,
  browser_status: Globe,
  browser_open: Globe,
  browser_navigate: Globe,
  browser_resize: Globe,
  browser_snapshot: Globe,
  browser_screenshot: Globe,
  browser_click: Globe,
  browser_type: Globe,
  browser_press: Globe,
  browser_scroll: Globe,
  browser_wait_for: Globe,
  browser_console: Globe,
  browser_network: Globe,
  browser_accessibility: Globe,
  browser_performance: Globe,
  browser_evaluate: Globe,
  browser_recording_start: Globe,
  browser_recording_stop: Globe,
};

export const DEFAULT_ICON: IconComponent = Wrench;

/** Provider-specific shell tool names normalized to `Bash`. */
const SHELL_TOOL_ALIASES: Record<string, "Bash"> = {
  Shell: "Bash",
  Terminal: "Bash",
  command_execution: "Bash",
};

/**
 * Maps provider-specific shell tool names to the canonical `Bash` label/icon set.
 */
export function resolveToolName(toolName: string): string {
  const browserTool = toolName.match(/(?:^|__)(browser_[a-z_]+)$/)?.[1];
  return SHELL_TOOL_ALIASES[toolName] ?? browserTool ?? toolName;
}

/** Returns true when the tool is a shell/command execution (any provider alias). */
export function isShellTool(toolName: string): boolean {
  return resolveToolName(toolName) === "Bash";
}

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
  browser_status: "Checking the Browser...",
  browser_open: "Opening a page...",
  browser_navigate: "Navigating the page...",
  browser_resize: "Resizing the Browser...",
  browser_snapshot: "Inspecting the page...",
  browser_screenshot: "Capturing the page...",
  browser_click: "Clicking the page...",
  browser_type: "Typing in the page...",
  browser_press: "Pressing a key...",
  browser_scroll: "Scrolling the page...",
  browser_wait_for: "Waiting for the page...",
  browser_console: "Inspecting the console...",
  browser_network: "Inspecting network activity...",
  browser_accessibility: "Inspecting accessibility...",
  browser_performance: "Auditing page performance...",
  browser_evaluate: "Evaluating the page...",
  browser_recording_start: "Starting page recording...",
  browser_recording_stop: "Stopping page recording...",
};

/** Singular/plural labels for tool summary text generation. */
export const TOOL_SUMMARY_VERBS: Record<string, [string, string]> = {
  Read: ["Read %d file", "Read %d files"],
  Glob: ["Listed %d directory", "Listed %d directories"],
  Grep: ["%d search", "%d searches"],
  Edit: ["Edited %d file", "Edited %d files"],
  Write: ["Created %d file", "Created %d files"],
  Bash: ["Ran %d command", "Ran %d commands"],
  WebSearch: ["%d web search", "%d web searches"],
  WebFetch: ["Fetched %d page", "Fetched %d pages"],
};

/**
 * Generate a summary string from a group of tool calls.
 * Example: "Read 3 files, 1 search"
 */
export function buildToolSummaryText(calls: readonly { toolName: string }[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const name = resolveToolName(c.toolName);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    const verbs = TOOL_SUMMARY_VERBS[name];
    if (verbs) {
      const template = count === 1 ? verbs[0] : verbs[1];
      parts.push(template.replace("%d", String(count)));
    } else {
      parts.push(`${count} ${name.toLowerCase()}${count > 1 ? "s" : ""}`);
    }
  }
  return parts.join(", ");
}
