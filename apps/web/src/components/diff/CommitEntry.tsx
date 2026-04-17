import { useState, useEffect, useCallback } from "react";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { GitCommit } from "@mcode/contracts";
import { FileList } from "./FileList";

/** Props for CommitEntry. */
interface CommitEntryProps {
  commit: GitCommit;
}

/** Format ISO date to a compact relative string. */
function relativeTime(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  if (!isFinite(then)) return "unknown";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(isoDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Get up to 2 uppercase initials from an author name. */
function getInitials(author: string): string {
  return author
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Single commit row. Avatar is a quiet typographic mark (initials in muted square),
 * not a colored chip. Hierarchy: SHA (mono leading) → message → time.
 */
export function CommitEntry({ commit }: CommitEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const loadFiles = useCallback(async () => {
    if (files !== null || !activeWorkspaceId) return;
    try {
      const result = await getTransport().getCommitFiles(activeWorkspaceId, commit.sha);
      setFiles(result);
    } catch {
      setFiles([]);
    }
  }, [commit.sha, activeWorkspaceId, files]);

  useEffect(() => {
    if (expanded && files === null) {
      loadFiles();
    }
  }, [expanded, files, loadFiles]);

  const initials = getInitials(commit.author);

  return (
    <div className={`border-b border-border/15 ${expanded ? "bg-muted/[0.04]" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-baseline gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/[0.08]"
      >
        {/* Leading SHA — typographic anchor */}
        <span className="shrink-0 font-mono text-[11px] text-foreground/55 group-hover:text-foreground/75 transition-colors tabular-nums">
          {commit.shortSha}
        </span>

        {/* Commit message */}
        <span className="flex-1 min-w-0 truncate text-[11.5px] text-foreground/80">
          {commit.message}
        </span>

        {/* Author initials — quiet square */}
        <span
          className="shrink-0 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[2px] bg-muted/60 px-1 font-mono text-[8.5px] tracking-tight text-muted-foreground/75"
          title={commit.author}
        >
          {initials}
        </span>

        {/* File count — quiet typographic label */}
        {files !== null && files.length > 0 && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/55">
            {files.length} file{files.length === 1 ? "" : "s"}
          </span>
        )}

        {/* Relative time */}
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/45">
          {relativeTime(commit.date)}
        </span>

        <span
          aria-hidden="true"
          className={`shrink-0 font-mono text-[11px] leading-none text-muted-foreground/35 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        >
          ›
        </span>
      </button>

      {expanded && (
        <div className="pb-1">
          {files === null ? (
            <div className="flex items-center gap-1.5 px-7 py-2">
              {[0, 150, 300].map((delay) => (
                <div
                  key={delay}
                  className="h-1 w-1 rounded-full bg-muted-foreground/40 animate-pulse"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          ) : files.length === 0 ? (
            <p className="px-7 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/40">
              No files changed
            </p>
          ) : (
            <FileList files={files} source="commit" id={commit.sha} />
          )}
        </div>
      )}
    </div>
  );
}
