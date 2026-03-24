import { useState } from "react";
import { Terminal } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";
import { ShowMoreButton } from "./ShowMoreButton";

const MAX_LINES = 20;

export function BashRenderer({ toolCall, isActive }: ToolRendererProps) {
  const [showAll, setShowAll] = useState(false);
  const command = String(toolCall.toolInput.command ?? "");
  const description = toolCall.toolInput.description
    ? String(toolCall.toolInput.description)
    : undefined;
  const outputLines = toolCall.output?.split("\n") ?? [];
  const visible = showAll ? outputLines : outputLines.slice(0, MAX_LINES);

  const badge = description ?? command.slice(0, 60) + (command.length > 60 ? "..." : "");

  return (
    <ToolCallWrapper
      icon={Terminal}
      label="Ran command"
      badge={badge}
      isActive={isActive}
    >
      <div className="space-y-1.5">
        <pre className="rounded bg-zinc-900 px-2.5 py-1.5 text-[11px] leading-relaxed text-zinc-300 font-mono overflow-x-auto">
          <span className="select-none text-zinc-500">$ </span>{command}
        </pre>

        {outputLines.length > 0 && (
          <div>
            <pre
              className={`max-h-64 overflow-auto rounded bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono ${
                toolCall.isError ? "border-l-2 border-red-500/50" : ""
              }`}
            >
              {visible.join("\n")}
            </pre>
            <ShowMoreButton
              totalCount={outputLines.length}
              visibleCount={MAX_LINES}
              expanded={showAll}
              onToggle={() => setShowAll((p) => !p)}
            />
          </div>
        )}
      </div>
    </ToolCallWrapper>
  );
}
