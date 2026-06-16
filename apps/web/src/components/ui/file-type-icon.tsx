import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { getFileIcon, getFileIconColor } from "@/lib/file-icons";
import { resolveIcon, type ResolvedIcon } from "@/lib/vscode-icons";

/** Props for {@link FileTypeIcon}. */
export interface FileTypeIconProps {
  /** Workspace-relative or absolute path; only the basename is used for lookup. */
  filePath: string;
  className?: string;
  /** Pixel size for the icon box. Defaults to 16. */
  size?: number;
}

/**
 * Renders the VSCode file-type icon for a path, falling back to colored Lucide
 * icons when the CDN icon is unavailable.
 */
export function FileTypeIcon({ filePath, className, size = 16 }: FileTypeIconProps) {
  const fileName = useMemo(
    () => filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1),
    [filePath],
  );
  const [resolved, setResolved] = useState<ResolvedIcon | null>(null);
  const fallbackIcon = useMemo(() => getFileIcon(filePath), [filePath]);
  const fallbackColor = useMemo(() => getFileIconColor(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;
    void resolveIcon(fileName).then((icon) => {
      if (!cancelled) setResolved(icon);
    });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  if (resolved?.type === "vscode") {
    return (
      <img
        src={resolved.url}
        alt=""
        aria-hidden="true"
        data-testid="file-type-icon-vscode"
        className={cn("shrink-0", className)}
        width={size}
        height={size}
      />
    );
  }

  const LucideIcon = resolved?.type === "lucide" ? resolved.icon : fallbackIcon;
  return (
    <LucideIcon
      aria-hidden="true"
      data-testid="file-type-icon-lucide"
      size={size}
      className={cn("shrink-0", fallbackColor, className)}
    />
  );
}
