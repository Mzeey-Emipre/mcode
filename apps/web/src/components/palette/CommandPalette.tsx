import { useEffect, type KeyboardEventHandler } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Plus, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { setContext } from "@/lib/context-tracker";
import { RootView } from "./views/RootView";
import { ProjectsView } from "@/features/projects";
import { BrowseView } from "./views/BrowseView";
import { SelectionListView } from "./views/SelectionListView";
import { ThreadSearchView } from "./views/ThreadSearchView";
import { isBrowseQuery, getPaletteMode } from "./CommandPalette.logic";
import { cn } from "@/lib/utils";

type PaletteView = ReturnType<typeof useCommandPaletteStore.getState>["viewStack"][number];

function isPaletteFocused(): boolean {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]')?.contains(document.activeElement) ?? false;
}

function consumePendingConfirm(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return false;
  const confirm = useCommandPaletteStore.getState().pendingConfirm;
  if (!confirm) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  confirm();
  return true;
}

function consumePendingBack(event: KeyboardEvent): void {
  if (event.key !== "ArrowUp" || !event.altKey) return;
  const back = useCommandPaletteStore.getState().pendingBack;
  if (!back) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  back();
}

function getPaletteDetails(browseMode: boolean, top: PaletteView | undefined, query: string): { placeholder: string; inputLabel: string; modeLabel: string; widthClass: string } {
  if (browseMode) return { placeholder: "Type a path or filter…", inputLabel: "Folder path or folder filter", modeLabel: "browse", widthClass: "max-w-[680px]" };
  if (top?.kind === "projects") return { placeholder: "Search projects…", inputLabel: "Command palette search", modeLabel: "projects", widthClass: "max-w-2xl" };
  if (top?.kind === "threadSearch") return { placeholder: "Search threads, projects, branches, worktrees…", inputLabel: "Search threads", modeLabel: "threads", widthClass: "max-w-3xl" };
  if (top?.kind === "selectionList") return { placeholder: `Search ${top.title.toLowerCase()}…`, inputLabel: "Command palette search", modeLabel: getPaletteMode(query), widthClass: "max-w-xl" };
  return { placeholder: "Search commands, type ~/ to browse, > for actions only…", inputLabel: "Command palette search", modeLabel: getPaletteMode(query), widthClass: "max-w-xl" };
}

function PaletteViewContent({ browseMode, top }: { browseMode: boolean; top: PaletteView | undefined }) {
  if (browseMode) return <BrowseView />;
  if (top?.kind === "projects") return <ProjectsView />;
  if (top?.kind === "threadSearch") return <ThreadSearchView />;
  if (top?.kind === "selectionList") return <SelectionListView view={top} />;
  return <RootView />;
}

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

  useEffect(() => {
    if (!isOpen) return;

    const handleBrowseShortcut = (event: KeyboardEvent) => {
      if (!isPaletteFocused()) return;
      if (consumePendingConfirm(event)) return;
      if (browseMode) consumePendingBack(event);
    };

    window.addEventListener("keydown", handleBrowseShortcut, true);
    return () => window.removeEventListener("keydown", handleBrowseShortcut, true);
  }, [browseMode, isOpen]);

  const paletteDetails = getPaletteDetails(browseMode, top, query);

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(o) => !o && close()} modal="trap-focus">
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="app-viewport-fixed fixed z-50 bg-black/55 backdrop-blur-xs duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
        <DialogPrimitive.Popup
          data-testid="command-palette"
          aria-label="Command palette"
          className={cn("fixed left-1/2 top-[clamp(4rem,14vh,8rem)] z-50 w-full -translate-x-1/2 px-4 outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none", paletteDetails.widthClass)}
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
              placeholder={paletteDetails.placeholder}
              query={query}
              setQuery={setQuery}
              browseMode={browseMode}
              canAdd={pendingConfirm != null}
              inputLabel={paletteDetails.inputLabel}
              modeLabel={paletteDetails.modeLabel}
              onKeyDown={(e) => {
                // Backspace on empty input pops the view stack.
                if (e.key === "Backspace" && query === "" && viewStack.length > 1) {
                  e.preventDefault();
                  pop();
                }
              }}
              onAddClick={() => pendingConfirm?.()}
            />

            <PaletteViewContent browseMode={browseMode} top={top} />
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
  canAdd,
  inputLabel,
  modeLabel,
  onKeyDown,
  onAddClick,
}: {
  placeholder: string;
  query: string;
  setQuery: (q: string) => void;
  browseMode: boolean;
  canAdd: boolean;
  inputLabel: string;
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
        aria-label={inputLabel}
        onValueChange={setQuery}
        onKeyDownCapture={onKeyDown}
        className={cn(
          // Reserve right padding for the browse action so the typed path
          // remains visible beneath long folder names.
          "flex w-full bg-transparent outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50",
          browseMode ? "h-[60px] pe-[148px] font-mono text-[14px]" : "h-12 text-sm",
        )}
      />
      {browseMode && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="absolute end-[16px] top-1/2 inline-flex -translate-y-1/2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  data-testid="palette-add-folder"
                  disabled={!canAdd}
                  onMouseDown={(e) => {
                    // Prevent the input from losing focus, which would dismiss cmdk highlight.
                    e.preventDefault();
                  }}
                  onClick={onAddClick}
                  className="h-[36px] min-w-[132px] gap-[8px] px-[16px] text-[14px] leading-none"
                >
                  <Plus size={14} />
                  Add project
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {canAdd ? "Add this folder as a project" : "Choose a folder before adding a project"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
