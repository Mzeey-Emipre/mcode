import { useState, useEffect, useCallback } from "react";
import { Plus, Minus } from "lucide-react";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { GitCommit } from "@/stores/diffStore";
import { FileEntry } from "./FileEntry";

/** Props for CommitEntry. */
interface CommitEntryProps {
  commit: GitCommit;
}

/** Format ISO date to a compact relative string. */
function relativeTime(isoDate: string): string {
  const diffSec = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
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

const AVATAR_PALETTES = [
  "bg-violet-500/20 text-violet-300",
  "bg-blue-500/20 text-blue-300",
  "bg-emerald-500/20 text-emerald-300",
  "bg-amber-500/20 text-amber-300",
  "bg-rose-500/20 text-rose-300",
  "bg-cyan-500/20 text-cyan-300",
];

/** Deterministic avatar color from an author string. */
function getAvatarColor(author: string): string {
  let hash = 0;
  for (const c of author) hash = ((hash * 31) + c.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTES[hash % AVATAR_PALETTES.length];
}

/** Single commit accordion: author avatar, SHA, message, relative time, and lazy file list. */
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

  const initials = getInitials(commit.author);
  const avatarColor = getAvatarColor(commit.author);

  return (
    <div className={`border-b border-border/15 ${expanded ? "bg-muted/5" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/15 transition-colors"
      >
        {expanded ? (
          <Minus size={11} className="shrink-0 text-muted-foreground/30" />
        ) : (
          <Plus size={11} className="shrink-0 text-muted-foreground/30" />
        )}

        {/* Author avatar */}
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${avatarColor}`}
          title={commit.author}
        >
          {initials}
        </span>

        {/* Commit message */}
        <span className="flex-1 min-w-0 truncate text-[11px] text-foreground/65">
          {commit.message}
        </span>

        {/* SHA + time */}
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[9px] text-muted-foreground/30">{commit.shortSha}</span>
          <span className="text-[9px] text-muted-foreground/25">{relativeTime(commit.date)}</span>
        </span>
      </button>

      {expanded && (
        <div className="pb-0.5">
          {files === null ? (
            <div className="flex items-center gap-1.5 px-7 py-2">
              {[0, 150, 300].map((delay) => (
                <div
                  key={delay}
                  className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          ) : files.length === 0 ? (
            <p className="px-7 py-2 text-[10px] text-muted-foreground/30">No files changed</p>
          ) : (
            files.map((filePath) => (
              <FileEntry key={filePath} filePath={filePath} source="commit" id={commit.sha} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
