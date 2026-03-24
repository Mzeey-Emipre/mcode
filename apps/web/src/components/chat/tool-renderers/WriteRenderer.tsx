import { useState } from "react";
import { FilePen } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";
import { ShowMoreButton } from "./ShowMoreButton";
import { basename } from "@/lib/path";

const MAX_LINES = 10;

export function WriteRenderer({ toolCall, isActive }: ToolRendererProps) {
  const [showAll, setShowAll] = useState(false);
  const filePath = String(toolCall.toolInput.file_path ?? "");
  const content = String(toolCall.toolInput.content ?? "");
  const lines = content.split("\n");
  const visible = showAll ? lines : lines.slice(0, MAX_LINES);

  return (
    <ToolCallWrapper
      icon={FilePen}
      label="Created file"
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
