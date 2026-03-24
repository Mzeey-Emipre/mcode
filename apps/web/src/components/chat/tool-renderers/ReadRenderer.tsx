import { useState } from "react";
import { FileText } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";
import { ShowMoreButton } from "./ShowMoreButton";
import { basename } from "@/lib/path";

const MAX_LINES = 20;

export function ReadRenderer({ toolCall, isActive }: ToolRendererProps) {
  const [showAll, setShowAll] = useState(false);
  const filePath = String(toolCall.toolInput.file_path ?? "");
  const lines = toolCall.output?.split("\n") ?? [];
  const visible = showAll ? lines : lines.slice(0, MAX_LINES);

  return (
    <ToolCallWrapper
      icon={FileText}
      label="Read file"
      badge={basename(filePath)}
      isActive={isActive}
    >
      {lines.length > 0 && (
        <div>
          <pre className="max-h-64 overflow-auto rounded bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono">
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
