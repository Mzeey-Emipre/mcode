import { useWorkspaceStore } from "@/stores/workspaceStore";
import { ThreadItem } from "./ThreadItem";
import { NewThreadDialog } from "./NewThreadDialog";
import { ScrollArea } from "@/components/ui/scroll-area";

export function ThreadList() {
  const threads = useWorkspaceStore((s) => s.threads);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          Threads
        </span>
        <NewThreadDialog />
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 px-2">
          {threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              isActive={activeThreadId === thread.id}
              onClick={() => setActiveThread(thread.id)}
            />
          ))}
          {threads.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No threads yet.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
