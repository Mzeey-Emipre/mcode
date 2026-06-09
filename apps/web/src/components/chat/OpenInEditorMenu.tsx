import { useEffect, useCallback } from "react";
import { FolderOpen } from "lucide-react";
import { getTransport } from "@/transport";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { registerCommand } from "@/lib/shortcuts";
import { formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { useToastStore } from "@/stores/toastStore";
import { openInAppIcon } from "./openInAppIcons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

interface AppEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

interface OpenInEditorMenuProps {
  /** Absolute path to open. */
  dirPath: string;
}

/** Dropdown menu that opens a directory in an installed editor, git GUI, or the system file explorer. */
export function OpenInEditorMenu({ dirPath }: OpenInEditorMenuProps) {
  const apps = useOpenInApps();

  // Editors and git GUIs both launch a directory; File Explorer is rendered
  // separately below because it owns the mod+o shortcut and is always present.
  const launchable = apps.filter(
    (app) => (app.kind === "editor" || app.kind === "gitGui") && app.detected,
  );
  const entries: AppEntry[] = launchable.map((app) => ({
    id: app.id,
    label: app.label,
    icon: openInAppIcon(app.iconKey, 16),
  }));

  const handleOpenApp = (appId: string) => {
    const label = launchable.find((app) => app.id === appId)?.label ?? appId;
    getTransport()
      .openIn(appId, dirPath)
      .catch((err) =>
        useToastStore.getState().show("error", `Could not open ${label}`, String(err?.message ?? err)),
      );
  };

  const handleOpenExplorer = useCallback(() => {
    getTransport()
      .openInExplorer(dirPath)
      .catch((err) =>
        useToastStore.getState().show("error", "Could not open explorer", String(err?.message ?? err)),
      );
  }, [dirPath]);

  // Ctrl/Cmd+O shortcut to open in file explorer (via centralized command system)
  useEffect(() => {
    return registerCommand({
      id: "explorer.open",
      title: "Open in File Explorer",
      category: "View",
      handler: handleOpenExplorer,
    });
  }, [handleOpenExplorer]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="xs" className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6">
            <FolderOpen size={12} />
            <span>Open</span>
          </Button>
        }
      />

      <DropdownMenuContent align="end" sideOffset={4} className="min-w-[160px]">
        {entries.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            onClick={() => handleOpenApp(entry.id)}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
          >
            {entry.icon}
            <span>{entry.label}</span>
          </DropdownMenuItem>
        ))}

        {entries.length > 0 && <DropdownMenuSeparator />}

        <DropdownMenuItem
          onClick={handleOpenExplorer}
          className="flex cursor-pointer items-center justify-between px-3 py-1.5 text-xs"
        >
          <span className="flex items-center gap-2">
            <FolderOpen size={14} />
            <span>Explorer</span>
          </span>
          <kbd className="ml-4 text-[10px] text-muted-foreground">{formatKeybinding("mod+o", isMac)}</kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
