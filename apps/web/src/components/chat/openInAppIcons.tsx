import type React from "react";
import { FolderOpen, Github } from "lucide-react";
import { VsCodeIcon, VisualStudioIcon, ZedIcon } from "./EditorIcons";
import { CursorProviderIcon } from "./ProviderIcons";

/**
 * Resolves an open-in app's `iconKey` (supplied by the desktop registry, since
 * React components can't cross the IPC boundary) to a rendered icon. This is the
 * single place icon keys map to components, replacing the per-component editor
 * config maps.
 */
export function openInAppIcon(iconKey: string, size: number): React.ReactNode {
  switch (iconKey) {
    case "vscode":
      return <VsCodeIcon size={size} />;
    case "visualstudio":
      return <VisualStudioIcon size={size} />;
    case "cursor":
      return <CursorProviderIcon size={size} />;
    case "zed":
      return <ZedIcon size={size} />;
    case "githubDesktop":
      return <Github size={size} />;
    case "explorer":
      return <FolderOpen size={size} />;
    default:
      return null;
  }
}
