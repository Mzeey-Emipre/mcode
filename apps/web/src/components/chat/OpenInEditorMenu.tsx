import { useEffect, useCallback } from "react";
import { FolderOpen } from "lucide-react";
import { getTransport } from "@/transport";
import { useInstalledEditors } from "@/hooks/useInstalledEditors";
import { registerShortcut } from "@/lib/shortcuts";
import { useToastStore } from "@/stores/toastStore";
import { VsCodeIcon, ZedIcon, CursorIcon } from "./EditorIcons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

interface EditorEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

const EDITOR_CONFIG: Record<string, { label: string; icon: (size: number) => React.ReactNode }> = {
  code: { label: "VS Code", icon: (s) => <VsCodeIcon size={s} /> },
  cursor: { label: "Cursor", icon: (s) => <CursorIcon size={s} /> },
  zed: { label: "Zed", icon: (s) => <ZedIcon size={s} /> },
};

interface OpenInEditorMenuProps {
  /** Absolute path to open. */
  dirPath: string;
}

/** Dropdown menu that opens a directory in an installed code editor or system file explorer. */
export function OpenInEditorMenu({ dirPath }: OpenInEditorMenuProps) {
  const installedEditors = useInstalledEditors();

  const entries: EditorEntry[] = installedEditors
    .filter((id) => id in EDITOR_CONFIG)
    .map((id) => ({
      id,
      label: EDITOR_CONFIG[id].label,
      icon: EDITOR_CONFIG[id].icon(16),
    }));

  const handleOpenEditor = (editorId: string) => {
    const label = EDITOR_CONFIG[editorId]?.label ?? editorId;
    getTransport()
      .openInEditor(editorId, dirPath)
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

  // Ctrl/Cmd+O shortcut to open in file explorer (via centralized shortcut system)
  useEffect(() => {
    return registerShortcut({
      key: "o",
      ctrl: true,
      description: "Open in file explorer",
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
            onClick={() => handleOpenEditor(entry.id)}
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
          <kbd className="ml-4 text-[10px] text-muted-foreground">Ctrl+O</kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
