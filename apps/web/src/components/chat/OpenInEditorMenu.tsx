import { ChevronDown, FolderOpen, Terminal } from "lucide-react";
import { getTransport } from "@/transport";
import { useInstalledEditors } from "@/hooks/useInstalledEditors";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const EDITOR_LABELS: Record<string, string> = {
  code: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
};

interface OpenInEditorMenuProps {
  /** Absolute path to open. */
  dirPath: string;
}

export function OpenInEditorMenu({ dirPath }: OpenInEditorMenuProps) {
  const installedEditors = useInstalledEditors();

  const handleOpenEditor = (editorId: string) => {
    getTransport().openInEditor(editorId, dirPath).catch(console.error);
  };

  const handleOpenExplorer = () => {
    getTransport().openInExplorer(dirPath).catch(console.error);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <FolderOpen size={12} />
        Open
        <ChevronDown size={10} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={4} className="min-w-[160px]">
        {installedEditors.map((id) => (
          <DropdownMenuItem
            key={id}
            onClick={() => handleOpenEditor(id)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs"
          >
            <Terminal size={14} />
            <span>{EDITOR_LABELS[id] ?? id}</span>
          </DropdownMenuItem>
        ))}

        {installedEditors.length > 0 && <DropdownMenuSeparator />}

        <DropdownMenuItem
          onClick={handleOpenExplorer}
          className="flex items-center gap-2 px-3 py-1.5 text-xs"
        >
          <FolderOpen size={14} />
          <span>Explorer</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
