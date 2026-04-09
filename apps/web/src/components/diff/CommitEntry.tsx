import { useState, useEffect, useCallback } from "react";
import { Plus, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { GitCommit } from "@mcode/contracts";
import { FileEntry } from "./FileEntry";

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

const AVATAR_PALETTES = [
  "bg-violet-500/20 text-violet-600 dark:text-violet-400",
  "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  "bg-rose-500/20 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
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
  const avatarColor = getAvatarColor(commit.author);

  return (
    <div className={`border-b border-border/30 ${expanded ? "bg-muted/5" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
      >
        {expanded ? (
          <Minus size={11} className="shrink-0 text-muted-foreground/70" />
        ) : (
          <Plus size={11} className="shrink-0 text-muted-foreground/70" />
        )}

        {/* Author avatar */}
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${avatarColor}`}
          title={commit.author}
        >
          {initials}
        </span>

        {/* Commit message */}
        <span className="flex-1 min-w-0 truncate text-[11px] text-foreground/80">
          {commit.message}
        </span>

        {/* File count badge (shown once files have loaded) + SHA + time */}
        <span className="flex shrink-0 items-center gap-1.5">
          {files !== null && files.length > 0 && (
            <Badge variant="ghost" size="sm" className="font-mono text-muted-foreground/60">
              {files.length} {files.length === 1 ? "file" : "files"}
            </Badge>
          )}
          <span className="font-mono text-[9px] text-muted-foreground/80">{commit.shortSha}</span>
          <span className="text-[9px] text-muted-foreground/70">{relativeTime(commit.date)}</span>
        </span>
      </button>

      {expanded && (
        <div className="pb-0.5">
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
            <p className="px-7 py-2 text-[10px] text-muted-foreground">No files changed</p>
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
