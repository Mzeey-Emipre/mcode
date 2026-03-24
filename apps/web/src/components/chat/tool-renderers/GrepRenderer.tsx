import { useState } from "react";
import { Search, File } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";
import { ShowMoreButton } from "./ShowMoreButton";

const MAX_VISIBLE = 15;

export function GrepRenderer({ toolCall, isActive }: ToolRendererProps) {
  const [showAll, setShowAll] = useState(false);
  const pattern = String(toolCall.toolInput.pattern ?? "");
  const lines = (toolCall.output ?? "").split("\n").filter((l) => l.trim());
  const visible = showAll ? lines : lines.slice(0, MAX_VISIBLE);

  const label = lines.length > 0
    ? `Found ${lines.length} result${lines.length !== 1 ? "s" : ""}`
    : "Searched files";

  return (
    <ToolCallWrapper
      icon={Search}
      label={label}
      badge={pattern}
      isActive={isActive}
    >
      {lines.length > 0 && (
        <div className="space-y-0.5">
          {visible.map((line, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <File size={12} className="shrink-0 opacity-60" />
              <span className="truncate font-mono text-[11px]">{line}</span>
            </div>
          ))}
          <ShowMoreButton
            totalCount={lines.length}
            visibleCount={MAX_VISIBLE}
            expanded={showAll}
            onToggle={() => setShowAll((p) => !p)}
          />
        </div>
      )}
    </ToolCallWrapper>
  );
}
