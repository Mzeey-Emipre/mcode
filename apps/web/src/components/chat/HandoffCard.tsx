import { memo, useState, useMemo } from "react";
import { ChevronRight, GitBranch, FileCode, ListChecks, GitCommit } from "lucide-react";
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
    <div className="my-3 overflow-hidden rounded-lg border border-border/50 bg-muted/20 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={`handoff-${metadata.parentThreadId}`}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/40"
      >
        <GitBranch size={14} className="shrink-0 text-primary/70" />
        <span className="font-medium text-foreground/90">
          Branched from <span className="text-primary/80">{metadata.parentTitle}</span>
        </span>
        <div className={`ml-auto shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}>
          <ChevronRight size={14} />
        </div>
      </button>

      {/* Expandable detail panel */}
      <div
        id={`handoff-${metadata.parentThreadId}`}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border/30 px-3 py-2.5 text-xs space-y-2">
            {/* Provider/Model row */}
            <div className="flex flex-wrap gap-2">
              {metadata.sourceProvider && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-muted-foreground">
                  Provider: <span className="font-medium text-foreground/80">{metadata.sourceProvider}</span>
                </span>
              )}
              {metadata.sourceModel && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-muted-foreground">
                  Model: <span className="font-medium text-foreground/80">{metadata.sourceModel}</span>
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-muted-foreground">
                Branch: <span className="font-medium text-foreground/80">{metadata.sourceBranch}</span>
              </span>
              {metadata.sourceHead && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-muted-foreground">
                  <GitCommit size={10} className="shrink-0" />
                  <span className="font-mono font-medium text-foreground/80">{metadata.sourceHead.slice(0, 7)}</span>
                </span>
              )}
            </div>

            {/* Files changed */}
            {metadata.recentFilesChanged.length > 0 && (
              <div>
                <span className="mb-1 flex items-center gap-1 text-muted-foreground">
                  <FileCode size={11} className="shrink-0" />
                  Recent files changed
                </span>
                <ul className="space-y-px pl-4">
                  {metadata.recentFilesChanged.map((f) => (
                    <li key={f} className="truncate font-mono text-foreground/80">{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Open tasks */}
            {metadata.openTasks.length > 0 && (
              <div>
                <span className="mb-1 flex items-center gap-1 text-muted-foreground">
                  <ListChecks size={11} className="shrink-0" />
                  Open tasks
                </span>
                <ul className="space-y-0.5 pl-4">
                  {metadata.openTasks.map((t, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-foreground/80">
                      <span className={`mt-px shrink-0 ${t.status === "completed" ? "text-green-500" : "text-muted-foreground/50"}`}>
                        {t.status === "completed" ? "✓" : "○"}
                      </span>
                      <span className={t.status === "completed" ? "line-through opacity-60" : ""}>{t.content}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
