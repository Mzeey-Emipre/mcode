import { useEffect, useMemo } from "react";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useRecentThreadsStore } from "@/stores/recentThreadsStore";
import { getAllCommands, executeCommand } from "@/lib/command-registry";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import {
  filterCommandPaletteGroups,
  buildProjectActionItems,
  buildThreadActionItems,
  type PaletteGroup,
} from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { Kbd } from "../Kbd";

// Commands that should not appear in the palette listing.
// `palette.open` and `commandPalette.toggle` are both bound to opening the palette
// itself — listing them inside the palette is circular. Their keybindings (mod+k /
// mod+p) still fire globally; only the in-palette row is suppressed.
const HIDDEN_COMMANDS = new Set([
  "escape.handle",
  "palette.open",
  "commandPalette.toggle",
]);

const QUICK_ACTION_IDS = new Set([
  "thread.new",
  "thread.search",
  "workspace.new",
  "terminal.toggle",
  "settings.open",
  "shortcuts.help",
]);

/**
 * Default root view of the command palette.
 * Shows three sections: Actions, Recent Threads, Recent Projects.
 * Search filters all three via rankSearchFieldMatch.
 * Typing ">" limits results to Actions only (matches VS Code convention).
 */
export function RootView() {
  const query = useCommandPaletteStore((s) => s.query);
  const close = useCommandPaletteStore((s) => s.close);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);

  // Cross-workspace recent threads — `useWorkspaceStore.threads` only carries
  // the active workspace's threads, so reading from it would silently drop
  // recents from other projects. The dedicated store is fed by the
  // `thread.listRecent` RPC and joins the parent workspace metadata.
  const recentThreads = useRecentThreadsStore((s) => s.threads);
  const fetchRecentThreads = useRecentThreadsStore((s) => s.fetch);
  useEffect(() => {
    fetchRecentThreads();
  }, [fetchRecentThreads]);

  // When query starts with ">" only show actions
  const actionOnly = query.startsWith(">");
  const effectiveQuery = actionOnly ? query.slice(1).trimStart() : query;

  const groups = useMemo<PaletteGroup[]>(() => {
    const commands = getAllCommands().filter((c) => !HIDDEN_COMMANDS.has(c.id));

    const visibleCommands = actionOnly || effectiveQuery
      ? commands
      : commands.filter((cmd) => QUICK_ACTION_IDS.has(cmd.id));

    const actionItems = visibleCommands.map((cmd) => {
      const binding = getKeybindingForCommand(cmd.id);
      return {
        value: `cmd:${cmd.id}`,
        title: cmd.title,
        description: binding ? formatKeybinding(binding.key, isMac) : undefined,
        searchTerms: [cmd.title.toLowerCase(), cmd.category.toLowerCase()],
      };
    });

    const result: PaletteGroup[] = [{
      heading: actionOnly || effectiveQuery ? "Actions" : "Quick actions",
      items: actionItems,
    }];

    if (!actionOnly) {
      // Recent threads — the store already returns the cross-workspace list
      // sorted freshest-first and capped server-side, so we just pass it
      // through without re-sorting or trimming here.
      if (recentThreads.length > 0) {
        result.push({
          heading: "Recent Threads",
          items: buildThreadActionItems(
            recentThreads.map((t) => ({
              id: t.id,
              title: t.title,
              // workspace_id is a ULID string at runtime; pass through as-is
              // so we don't NaN-out the ID we'd need for cross-workspace
              // routing.
              workspaceId: t.workspace_id,
              createdAt: new Date(t.created_at).getTime(),
              updatedAt: new Date(t.updated_at).getTime(),
            })),
          ),
        });
      }

      // Recent projects (last 8, by last_opened_at). The store uses snake_case fields
      // mirroring the SQLite columns; the previous camelCase reads silently produced
      // an empty list because every value was `undefined`.
      const recentProjects = [...workspaces]
        .filter((w) => w.last_opened_at != null)
        .sort((a, b) => (b.last_opened_at ?? 0) - (a.last_opened_at ?? 0))
        .slice(0, 8);

      if (recentProjects.length > 0) {
        result.push({
          heading: "Recent Projects",
          items: buildProjectActionItems(
            recentProjects.map((w) => ({
              // ULID string flows through `workspace:${id}` and round-trips intact in handleSelect.
              id: w.id,
              name: w.name,
              path: w.path,
              pinned: w.pinned ?? false,
              lastOpenedAt: w.last_opened_at ?? null,
              isGitRepo: w.is_git_repo ?? false,
              createdAt: new Date(w.created_at ?? 0).getTime(),
              updatedAt: new Date(w.updated_at ?? 0).getTime(),
            })),
          ),
        });
      }
    }

    return filterCommandPaletteGroups(result, effectiveQuery);
  }, [effectiveQuery, actionOnly, recentThreads, workspaces]);

  const handleSelect = (value: string) => {
    if (value.startsWith("cmd:")) {
      const id = value.slice(4);
      close();
      requestAnimationFrame(() => executeCommand(id));
    } else if (value.startsWith("workspace:")) {
      const id = value.slice(10);
      setActiveWorkspace(id);
      close();
    } else if (value.startsWith("thread:")) {
      const id = value.slice(7);
      // Activate the thread's workspace first so downstream selectors (sidebar
      // highlight, breadcrumb, settings panel) resolve against the right
      // workspace before the thread itself becomes active. Look up against
      // the cross-workspace recents list so threads from other projects route
      // correctly (per-workspace `useWorkspaceStore.threads` would miss them).
      const thread = recentThreads.find((t) => t.id === id);
      if (thread) setActiveWorkspace(String(thread.workspace_id));
      setActiveThread(id);
      close();
    }
  };

  const footer = (
    <div className="flex items-center justify-between gap-3 border-t border-border/50 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/70">
      <div className="flex items-center gap-3">
        <span>
          <Kbd>&gt;</Kbd> <span className="ml-1">Actions only</span>
        </span>
        <span>
          <Kbd>~/</Kbd> <span className="ml-1">Browse</span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span>
          <Kbd>↑↓</Kbd> Move
        </span>
        <span>
          <Kbd>↵</Kbd> Select
        </span>
        <span>
          <Kbd>Esc</Kbd> Close
        </span>
      </div>
    </div>
  );

  return <CommandPaletteResults groups={groups} onSelect={handleSelect} footer={footer} />;
}
