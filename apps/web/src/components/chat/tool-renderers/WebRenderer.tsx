import { useState } from "react";
import { Globe } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";
import { ShowMoreButton } from "./ShowMoreButton";

const MAX_LINES = 15;

export function WebRenderer({ toolCall, isActive }: ToolRendererProps) {
  const [showAll, setShowAll] = useState(false);
  const isSearch = toolCall.toolName === "WebSearch";
  const badge = String(toolCall.toolInput.query ?? toolCall.toolInput.url ?? "");
  const lines = (toolCall.output ?? "").split("\n");
  const visible = showAll ? lines : lines.slice(0, MAX_LINES);

  return (
    <ToolCallWrapper
      icon={Globe}
      label={isSearch ? "Searched web" : "Fetched page"}
      badge={badge}
      isActive={isActive}
    >
      {lines.length > 0 && lines[0].trim() && (
        <div>
          <pre className="max-h-64 overflow-auto rounded bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap">
            {visible.join("\n")}
          </pre>
          <ShowMoreButton
            totalCount={lines.length}
            visibleCount={MAX_LINES}
            expanded={showAll}
            onToggle={() => setShowAll((p) => !p)}
          />
        </div>
      )}
    </ToolCallWrapper>
  );
}
