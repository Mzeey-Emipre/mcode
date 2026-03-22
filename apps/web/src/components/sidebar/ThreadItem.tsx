import type { Thread } from "@/transport";
import { cn } from "@/lib/utils";
import {
  MessageSquare,
  GitBranch,
  CircleDot,
  CircleCheck,
  CircleX,
  CirclePause,
  Archive,
} from "lucide-react";

interface ThreadItemProps {
  thread: Thread;
  isActive: boolean;
  onClick: () => void;
}

const statusIcons = {
  active: CircleDot,
  paused: CirclePause,
  interrupted: CirclePause,
  errored: CircleX,
  archived: Archive,
  completed: CircleCheck,
  deleted: CircleX,
} as const;

const statusColors = {
  active: "text-green-500",
  paused: "text-yellow-500",
  interrupted: "text-yellow-500",
  errored: "text-red-500",
  archived: "text-muted-foreground",
  completed: "text-blue-500",
  deleted: "text-muted-foreground",
} as const;

export function ThreadItem({ thread, isActive, onClick }: ThreadItemProps) {
  const StatusIcon = statusIcons[thread.status] ?? MessageSquare;
  const statusColor = statusColors[thread.status] ?? "text-muted-foreground";

  return (
    <div
      className={cn(
        "group flex flex-col gap-1 rounded-md px-2 py-1.5 cursor-pointer",
        isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        <StatusIcon size={12} className={cn("shrink-0", statusColor)} />
        <span className="truncate text-sm flex-1">{thread.title}</span>
      </div>
      <div className="flex items-center gap-2 pl-5">
        <GitBranch size={10} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-xs text-muted-foreground">
          {thread.branch}
        </span>
        {thread.mode === "worktree" && (
          <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">
            worktree
          </span>
        )}
      </div>
    </div>
  );
}
