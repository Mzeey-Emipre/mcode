import { useState } from "react";
import { FolderSearch, Folder, File } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";
import { ShowMoreButton } from "./ShowMoreButton";

const MAX_VISIBLE = 15;

function parseFiles(output: string | null): string[] {
  if (!output) return [];
  return output.split("\n").filter((l) => l.trim().length > 0);
}

export function GlobRenderer({ toolCall, isActive }: ToolRendererProps) {
  const [showAll, setShowAll] = useState(false);
  const files = parseFiles(toolCall.output);
  const pattern = String(toolCall.toolInput.pattern ?? "");

  const label = files.length > 0
    ? `Listed ${files.length} file${files.length !== 1 ? "s" : ""}`
    : "Listed directory";

  const visible = showAll ? files : files.slice(0, MAX_VISIBLE);

  return (
    <ToolCallWrapper
      icon={FolderSearch}
      label={label}
      badge={pattern}
      isActive={isActive}
    >
      {files.length > 0 && (
        <div className="space-y-0.5">
          {visible.map((f, i) => {
            const isDir = f.endsWith("/");
            const IconEl = isDir ? Folder : File;
            return (
              <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <IconEl size={12} className="shrink-0 opacity-60" />
                <span className="truncate">{f}</span>
              </div>
            );
          })}
          <ShowMoreButton
            totalCount={files.length}
            visibleCount={MAX_VISIBLE}
            expanded={showAll}
            onToggle={() => setShowAll((p) => !p)}
          />
        </div>
      )}
    </ToolCallWrapper>
  );
}
