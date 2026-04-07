import { memo, useState, useMemo } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { parseHandoffJson } from "./handoff-utils";

/** Props for HandoffCard. */
interface HandoffCardProps {
  /** Raw content of the handoff system message. */
  content: string;
}

/** Collapsible card showing thread branching context. Collapsed by default. */
export const HandoffCard = memo(function HandoffCard({ content }: HandoffCardProps) {
  const [expanded, setExpanded] = useState(false);
  const metadata = useMemo(() => parseHandoffJson(content), [content]);

  if (!metadata) return null;

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <GitBranch size={14} className="shrink-0" />
        <span className="font-medium">Context from {metadata.parentTitle}</span>
        {expanded ? <ChevronDown size={14} className="ml-auto" /> : <ChevronRight size={14} className="ml-auto" />}
      </button>

      {expanded && (
        <div className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground space-y-1.5">
          <div className="flex gap-4">
            {metadata.sourceProvider && (
              <span>Provider: <span className="text-foreground">{metadata.sourceProvider}</span></span>
            )}
            {metadata.sourceModel && (
              <span>Model: <span className="text-foreground">{metadata.sourceModel}</span></span>
            )}
          </div>
          <div>
            Branch: <span className="text-foreground">{metadata.sourceBranch}</span>
          </div>
          {metadata.sourceHead && (
            <div>
              HEAD: <span className="font-mono text-foreground">{metadata.sourceHead.slice(0, 7)}</span>
            </div>
          )}
          {metadata.recentFilesChanged.length > 0 && (
            <div>
              <span className="block mb-0.5">Recent files changed:</span>
              <ul className="list-disc list-inside pl-1">
                {metadata.recentFilesChanged.map((f) => (
                  <li key={f} className="font-mono text-foreground truncate">{f}</li>
                ))}
              </ul>
            </div>
          )}
          {metadata.openTasks.length > 0 && (
            <div>
              <span className="block mb-0.5">Open tasks:</span>
              <ul className="list-none pl-1 space-y-0.5">
                {metadata.openTasks.map((t, i) => (
                  <li key={i} className="text-foreground">
                    {t.status === "completed" ? "[x]" : "[ ]"} {t.content}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
