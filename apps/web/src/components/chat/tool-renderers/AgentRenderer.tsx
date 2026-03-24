import { useState } from "react";
import { Bot } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";

export function AgentRenderer({ toolCall, isActive }: ToolRendererProps) {
  const [showResult, setShowResult] = useState(false);
  const description = String(toolCall.toolInput.description ?? "");
  const prompt = String(toolCall.toolInput.prompt ?? "");
  const summary = description || prompt.slice(0, 80) + (prompt.length > 80 ? "..." : "");

  return (
    <ToolCallWrapper
      icon={Bot}
      label="Thinking deeper..."
      badge={summary}
      isActive={isActive}
    >
      <div className="space-y-1.5">
        {prompt && (
          <pre className="rounded bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap">
            {prompt}
          </pre>
        )}
        {toolCall.output && (
          <div>
            <button
              type="button"
              onClick={() => setShowResult((p) => !p)}
              className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
            >
              {showResult ? "Hide result" : "Show result"}
            </button>
            {showResult && (
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap">
                {toolCall.output}
              </pre>
            )}
          </div>
        )}
      </div>
    </ToolCallWrapper>
  );
}
