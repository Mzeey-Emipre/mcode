import { useEffect, type KeyboardEventHandler } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Plus, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { setContext } from "@/lib/context-tracker";
import { RootView } from "./views/RootView";
import { ProjectsView } from "./views/ProjectsView";
import { BrowseView } from "./views/BrowseView";
import { SelectionListView } from "./views/SelectionListView";
import { ThreadSearchView } from "./views/ThreadSearchView";
import { isBrowseQuery, getPaletteMode } from "./CommandPalette.logic";
import { cn } from "@/lib/utils";

/**
 * Top-center floating command palette overlay — the single shell that handles
 * commands, project picking, thread switching, and folder browsing.
 *
 * Mode is derived from the input query each render (see `getPaletteMode`):
 * - Empty / actions-only / search modes render `<RootView />`.
 * - Browse / drives modes render `<BrowseView />`.
 *
 * The user disambiguates intent by typing — there is no view switching for
 * folder browsing. View-stack `push` is reserved for explicit submenus
 * (currently only `projects` and `selectionList`).
 */
export function CommandPalette() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const viewStack = useCommandPaletteStore((s) => s.viewStack);
  const query = useCommandPaletteStore((s) => s.query);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const close = useCommandPaletteStore((s) => s.close);
  const pop = useCommandPaletteStore((s) => s.pop);
  const pendingConfirm = useCommandPaletteStore((s) => s.pendingConfirm);

  const top = viewStack[viewStack.length - 1];
  const browseMode = isBrowseQuery(query);

  // Keep context tracker in sync so keybinding `when` clauses can check palette state
  useEffect(() => {
    setContext("commandPaletteOpen", isOpen);
  }, [isOpen]);

  // The placeholder hints at what the input does in the current view/mode.
  const placeholder = browseMode
    ? "Type a path or filter…"
    : top?.kind === "projects"
      ? "Search projects…"
      : top?.kind === "threadSearch"
        ? "Search thread title, project, provider, branch, or worktree…"
      : top?.kind === "selectionList"
        ? `Search ${top.title.toLowerCase()}…`
        : "Search commands, type ~/ to browse, > for actions only…";

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(o) => !o && close()} modal="trap-focus">
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
        <DialogPrimitive.Popup
          data-testid="command-palette"
          className={cn(
            "fixed left-1/2 top-[clamp(4rem,14vh,8rem)] z-50 w-full -translate-x-1/2 px-4 outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none",
            browseMode
              ? "max-w-[680px]"
              : top?.kind === "projects" || top?.kind === "threadSearch"
                ? "max-w-2xl"
                : "max-w-xl",
          )}
        >
          <Command
            className="overflow-hidden rounded-xl bg-popover shadow-lg ring-1 ring-foreground/10"
            // We do all filtering/ranking ourselves (filterCommandPaletteGroups,
            // BrowseView's leaf prefix filter, ProjectsView's substring filter),
            // so disable cmdk's built-in filter. Letting it run against the raw
            // query incorrectly hides matches when the query has special prefixes
            // like `>` or `~/` that don't appear in any item's value.
            shouldFilter={false}
            loop
          >
            <PaletteInput
              placeholder={placeholder}
              query={query}
              setQuery={setQuery}
              browseMode={browseMode}
              modeLabel={browseMode ? "browse" : top?.kind === "projects" ? "projects" : top?.kind === "threadSearch" ? "threads" : getPaletteMode(query)}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter triggers the active view's confirm action.
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  const confirm = useCommandPaletteStore.getState().pendingConfirm;
                  if (confirm) {
                    e.preventDefault();
                    e.stopPropagation();
                    confirm();
                    return;
                  }
                }
                // Backspace on empty input pops the view stack.
                if (e.key === "Backspace" && query === "" && viewStack.length > 1) {
                  e.preventDefault();
                  pop();
                }
              }}
              onAddClick={() => pendingConfirm?.()}
            />

            {browseMode ? (
              <BrowseView />
            ) : top?.kind === "projects" ? (
              <ProjectsView />
            ) : top?.kind === "threadSearch" ? (
              <ThreadSearchView />
            ) : top?.kind === "selectionList" ? (
              <SelectionListView view={top} />
            ) : (
              <RootView />
            )}
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Input row with the search icon on the left and the browse confirmation
 * action on the right when a folder path is active.
 */
function PaletteInput({
  placeholder,
  query,
  setQuery,
  browseMode,
  modeLabel,
  onKeyDown,
  onAddClick,
}: {
  placeholder: string;
  query: string;
  setQuery: (q: string) => void;
  browseMode: boolean;
  modeLabel: string;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onAddClick: () => void;
}) {
  return (
    <div
      data-slot="palette-input-wrapper"
      data-palette-mode={modeLabel}
      className={cn(
        "relative flex items-center border-b border-border/60",
        browseMode ? "h-[60px] px-[20px]" : "h-12 px-4",
      )}
    >
      <SearchIcon className={cn("size-4 shrink-0 text-muted-foreground/75", browseMode ? "mr-3" : "mr-2.5")} />
      <CommandPrimitive.Input
        autoFocus
        data-slot="palette-input"
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
        onKeyDown={onKeyDown}
        className={cn(
          // Reserve right padding for the browse action so the typed path
          // remains visible beneath long folder names.
          "flex w-full bg-transparent outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50",
          browseMode ? "h-[60px] pe-[148px] font-mono text-[14px]" : "h-12 text-sm",
        )}
      />
      {browseMode && (
        <Button
          type="button"
          variant="default"
          size="sm"
          data-testid="palette-add-folder"
          onMouseDown={(e) => {
            // Prevent the input from losing focus, which would dismiss cmdk highlight.
            e.preventDefault();
          }}
          onClick={onAddClick}
          title="Add this folder as a project"
          className="absolute end-[16px] top-1/2 h-[36px] min-w-[132px] -translate-y-1/2 gap-[8px] px-[16px] text-[14px] leading-none"
        >
          <Plus size={14} />
          Add project
        </Button>
      )}
    </div>
  );
}
