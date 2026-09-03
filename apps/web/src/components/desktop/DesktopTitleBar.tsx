import { useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Menu as MenuIcon,
  PanelLeft,
} from "lucide-react";
import { McodeLogo } from "@/components/brand/McodeLogo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { executeCommand } from "@/lib/command-registry";
import { cn } from "@/lib/utils";
import type { DesktopWindowAction } from "@/transport/desktop-bridge";

type DesktopMenuName = "file" | "edit" | "view" | "help";

/** Props for the persistent Electron title bar. */
export interface DesktopTitleBarProps {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
}

function nativeAction(action: DesktopWindowAction): void {
  void window.desktopBridge?.window.perform(action);
}

function openSettings(section: "about" | "keyboard"): void {
  window.dispatchEvent(
    new CustomEvent("mcode:open-settings", { detail: { section } }),
  );
}

function MenuItems({
  name,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
}: {
  readonly name: DesktopMenuName;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}) {
  if (name === "file") {
    return (
      <>
        <DropdownMenuItem onClick={() => executeCommand("workspace.new")}>
          New project
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => executeCommand("thread.new")}>
          New thread
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => nativeAction("closeWindow")}>
          Close window
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("quit")}>
          Quit
        </DropdownMenuItem>
      </>
    );
  }
  if (name === "edit") {
    return (
      <>
        <DropdownMenuItem onClick={() => nativeAction("undo")}>
          Undo
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("redo")}>
          Redo
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => nativeAction("cut")}>
          Cut
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("copy")}>
          Copy
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("paste")}>
          Paste
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("selectAll")}>
          Select all
        </DropdownMenuItem>
      </>
    );
  }
  if (name === "view") {
    return (
      <>
        <DropdownMenuItem disabled={!canGoBack} onClick={onBack}>
          Back
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canGoForward} onClick={onForward}>
          Forward
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => executeCommand("sidebar.toggle")}>
          Toggle sidebar
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => executeCommand("rightPanel.toggle")}>
          Toggle right panel
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => nativeAction("zoomIn")}>
          Zoom in
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("zoomOut")}>
          Zoom out
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("zoomReset")}>
          Actual size
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nativeAction("toggleFullScreen")}>
          Toggle full screen
        </DropdownMenuItem>
        {window.desktopBridge?.window.isDevelopment ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => nativeAction("reload")}>
              Reload
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => nativeAction("toggleDevTools")}>
              Developer tools
            </DropdownMenuItem>
          </>
        ) : null}
      </>
    );
  }
  return (
    <>
      <DropdownMenuItem onClick={() => openSettings("keyboard")}>
        Keyboard shortcuts
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => openSettings("about")}>
        About Mcode
      </DropdownMenuItem>
    </>
  );
}

const MENU_LABELS: ReadonlyArray<{
  name: DesktopMenuName;
  label: string;
  mnemonic: string;
}> = [
  { name: "file", label: "File", mnemonic: "f" },
  { name: "edit", label: "Edit", mnemonic: "e" },
  { name: "view", label: "View", mnemonic: "v" },
  { name: "help", label: "Help", mnemonic: "h" },
];

/** Electron-only title bar for app navigation, menus, and native window chrome. */
export function DesktopTitleBar({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: DesktopTitleBarProps) {
  const triggerRefs = useRef<
    Partial<Record<DesktopMenuName, HTMLButtonElement | null>>
  >({});
  const platform = window.desktopBridge?.window.platform;
  const showMenus = platform !== "darwin";

  useEffect(() => {
    if (!showMenus) return;
    const handleMnemonic = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      if (!window.matchMedia("(min-width: 721px)").matches) return;
      const item = MENU_LABELS.find(
        ({ mnemonic }) => mnemonic === event.key.toLowerCase(),
      );
      if (!item) return;
      event.preventDefault();
      triggerRefs.current[item.name]?.click();
    };
    document.addEventListener("keydown", handleMnemonic);
    return () => document.removeEventListener("keydown", handleMnemonic);
  }, [showMenus]);

  return (
    <header
      data-testid="desktop-title-bar"
      style={{ zIndex: "var(--z-desktop-title-bar)" }}
      className={cn(
        "relative flex h-12 shrink-0 select-none items-center gap-2 border-b border-border/40 bg-page px-2 [app-region:drag]",
        // Reserve room for the native caption-button overlay (minimize,
        // maximize, close) so it sits fully inside the bar on Windows/Linux.
        platform === "darwin" ? "pl-20" : "pr-[138px]",
      )}
    >
      <div
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center [&_img]:!size-6 [&>div]:!gap-0"
      >
        <McodeLogo markOnly />
      </div>
      <div className="flex items-center gap-1 [app-region:no-drag]">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle sidebar"
          onClick={() => executeCommand("sidebar.toggle")}
        >
          <PanelLeft size={16} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeft size={16} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={onForward}
        >
          <ArrowRight size={16} aria-hidden />
        </Button>
      </div>
      {showMenus ? (
        <nav
          aria-label="Application menu"
          className="flex min-w-0 items-center [app-region:no-drag]"
        >
          <div className="hidden items-center min-[721px]:flex">
            {MENU_LABELS.map(({ name, label, mnemonic }) => (
              <DropdownMenu key={name}>
                <DropdownMenuTrigger
                  ref={(node) => {
                    triggerRefs.current[name] = node;
                  }}
                  className="h-8 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-keyshortcuts={`Alt+${mnemonic.toUpperCase()}`}
                >
                  {label}
                </DropdownMenuTrigger>
                <DropdownMenuContent sideOffset={2} className="min-w-48">
                  <MenuItems
                    name={name}
                    {...{ canGoBack, canGoForward, onBack, onForward }}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          </div>
          <div className="min-[721px]:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Application menu"
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MenuIcon size={16} aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent sideOffset={2} className="min-w-48">
                {MENU_LABELS.map(({ name, label }) => (
                  <DropdownMenuSub key={name}>
                    <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-48">
                      <MenuItems
                        name={name}
                        {...{ canGoBack, canGoForward, onBack, onForward }}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </nav>
      ) : null}
      <span className="min-w-0 flex-1" />
    </header>
  );
}
