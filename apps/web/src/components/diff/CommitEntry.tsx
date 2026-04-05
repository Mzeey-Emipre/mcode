import { useState, useEffect, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { GitCommit } from "@/stores/diffStore";
import { FileEntry } from "./FileEntry";

/** Props for CommitEntry. */
interface CommitEntryProps {
  commit: GitCommit;
}

/** Format ISO date string to relative time (e.g. "2h ago"). */
function relativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

/** Single commit accordion: SHA, message, author, relative time, file list. */
export function CommitEntry({ commit }: CommitEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const loadFiles = useCallback(async () => {
    if (files !== null || !activeWorkspaceId) return;
    try {
      const diff = await getTransport().getCommitDiff(activeWorkspaceId, commit.sha);
      const fileSet = new Set<string>();
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git")) {
          const match = line.match(/b\/(.+)$/);
          if (match) fileSet.add(match[1]);
        }
      }
      setFiles([...fileSet]);
    } catch {
      setFiles([]);
    }
  }, [commit.sha, activeWorkspaceId, files]);

  useEffect(() => {
    if (expanded && files === null) {
      loadFiles();
    }
  }, [expanded, files, loadFiles]);

  return (
    <div className="border-b border-border/20">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-muted-foreground/50 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0">
          {commit.shortSha}
        </span>
        <span className="flex-1 truncate text-xs text-foreground/70">
          {commit.message}
        </span>
        <span className="text-[10px] text-muted-foreground/40 shrink-0">
          {relativeTime(commit.date)}
        </span>
      </button>

      {expanded && (
        <div className="pb-1">
          {files === null ? (
            <p className="px-3 py-1 text-[11px] text-muted-foreground/40">Loading files...</p>
          ) : files.length === 0 ? (
            <p className="px-3 py-1 text-[11px] text-muted-foreground/40">No files changed</p>
          ) : (
            files.map((filePath) => (
              <FileEntry
                key={filePath}
                filePath={filePath}
                source="commit"
                id={commit.sha}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
