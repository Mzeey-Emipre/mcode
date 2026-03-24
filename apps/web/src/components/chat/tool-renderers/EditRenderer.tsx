import { Pencil } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";
import { buildSimpleDiff } from "@/lib/diff";
import { basename } from "@/lib/path";

export function EditRenderer({ toolCall, isActive }: ToolRendererProps) {
  const filePath = String(toolCall.toolInput.file_path ?? "");
  const oldStr = String(toolCall.toolInput.old_string ?? "");
  const newStr = String(toolCall.toolInput.new_string ?? "");
  const lines = buildSimpleDiff(oldStr, newStr);

  return (
    <ToolCallWrapper
      icon={Pencil}
      label="Edited file"
      badge={basename(filePath)}
      isActive={isActive}
      defaultExpanded
    >
      {lines.length > 0 && (
        <div className="rounded border border-border/30 overflow-hidden font-mono text-[11px] leading-relaxed">
          {lines.map((line, i) => (
            <div
              key={i}
              className={`px-3 py-0.5 ${
                line.type === "remove"
                  ? "bg-red-500/10 text-red-400"
                  : "bg-green-500/10 text-green-400"
              }`}
            >
              <span className="select-none text-muted-foreground/40 mr-2 inline-block w-3 text-right">
                {line.type === "remove" ? "−" : "+"}
              </span>
              {line.content}
            </div>
          ))}
        </div>
      )}
    </ToolCallWrapper>
  );
}
