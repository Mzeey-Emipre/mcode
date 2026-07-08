import { useEffect, type KeyboardEventHandler } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { setContext } from "@/lib/context-tracker";
import { isMac } from "@/lib/platform";
import { RootView } from "./views/RootView";
import { ProjectsView } from "./views/ProjectsView";
import { BrowseView } from "./views/BrowseView";
import { SelectionListView } from "./views/SelectionListView";
import { Kbd } from "./Kbd";
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
      : top?.kind === "selectionList"
        ? `Search ${top.title.toLowerCase()}…`
        : "Search commands, type ~/ to browse, > for actions only…";

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(o) => !o && close()} modal="trap-focus">
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm" />
        <DialogPrimitive.Popup
          data-testid="command-palette"
          className={cn(
            "fixed left-1/2 top-[clamp(4rem,15vh,9rem)] z-50 w-full -translate-x-1/2 outline-none",
            top?.kind === "projects" ? "max-w-2xl" : "max-w-xl",
          )}
        >
          <Command
            className="rounded-lg border border-border bg-popover shadow-2xl"
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
              modeLabel={browseMode ? "browse" : top?.kind === "projects" ? "projects" : getPaletteMode(query)}
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
 * Input row with the search icon on the left and an optional inline "Add"
 * chip on the right (visible only in browse mode). The chip is purely a
 * visual hint — the actual confirm is wired through `pendingConfirm` and
 * Ctrl/Cmd+Enter in the parent shell.
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
  const modKey = isMac ? "⌘" : "Ctrl";
  return (
    <div
      data-slot="palette-input-wrapper"
      data-palette-mode={modeLabel}
      className="relative flex items-center border-b border-border px-3"
    >
      <SearchIcon className="mr-2 size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        autoFocus
        data-slot="palette-input"
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
        onKeyDown={onKeyDown}
        className={
          // Reserve right padding for the Add chip when it's visible so the
          // typed path doesn't get hidden under it.
          "flex h-10 w-full rounded-md bg-transparent py-3 text-[13.5px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 " +
          (browseMode ? "pe-44" : "")
        }
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
          title={`Add this folder as a project (${modKey}+Enter)`}
          className="absolute end-3 top-1/2 -translate-y-1/2"
        >
          Add
          <Kbd variant="inline">{modKey}+Enter</Kbd>
        </Button>
      )}
    </div>
  );
}
