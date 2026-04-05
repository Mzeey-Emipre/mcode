import { useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskGroup } from "./TaskGroup";

/** Task panel content rendered inside the RightPanel wrapper. */
export function TaskPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const tasks = useTaskStore(
    (s) => (activeThreadId ? s.tasksByThread[activeThreadId] : undefined),
  );

  const groups = useMemo(() => {
    if (!tasks) return [];
    const map = new Map<string, (typeof tasks)[number][]>();
    for (const task of tasks) {
      const list = map.get(task.group) ?? [];
      list.push(task);
      map.set(task.group, list);
    }
    return Array.from(map.entries());
  }, [tasks]);

  const hasTasks = tasks && tasks.length > 0;

  return hasTasks ? (
    <ScrollArea className="flex-1">
      <div className="flex flex-col py-1">
        {groups.map(([name, items]) => (
          <TaskGroup
            key={name}
            name={name}
            tasks={items}
            hideHeader={groups.length === 1 && name === "Tasks"}
          />
        ))}
      </div>
    </ScrollArea>
  ) : (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-xs text-muted-foreground/40">No tasks yet</p>
    </div>
  );
}
