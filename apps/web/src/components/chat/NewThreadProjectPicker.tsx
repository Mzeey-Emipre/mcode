import { useState } from "react";
import { Folder, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Project chooser shown in the new-thread context rail before a project is selected. */
export function NewThreadProjectPicker() {
  const [open, setOpen] = useState(false);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const beginNewThread = useWorkspaceStore((state) => state.beginNewThread);

  const handleAddProject = () => {
    setOpen(false);
    queueMicrotask(() => {
      useCommandPaletteStore.getState().open({ intent: "addProject" });
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="new-thread-project-picker"
            aria-expanded={open}
            className="h-[28px] gap-[6px] rounded-md px-[10px] text-[12px] font-medium leading-none text-foreground/90 hover:bg-accent/70"
          >
            <Folder size={14} className="size-3.5 text-muted-foreground" aria-hidden />
            Choose project
          </Button>
        }
      />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 overflow-hidden p-0 shadow-lg"
      >
        <Command>
          <CommandInput placeholder="Search projects…" aria-label="Search projects" />
          <CommandList className="max-h-64 p-1">
            <CommandEmpty>No matching projects.</CommandEmpty>
            {workspaces.map((workspace) => (
              <CommandItem
                key={workspace.id}
                value={`${workspace.name} ${workspace.path}`}
                onSelect={() => {
                  beginNewThread(workspace.id);
                  setOpen(false);
                }}
                className="gap-2.5 px-2 py-1.5 text-[13px]"
              >
                <Folder size={13} className="text-muted-foreground" aria-hidden />
                <span className="truncate">{workspace.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <div className="border-t border-border/60 p-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleAddProject}
            className="h-8 w-full justify-start gap-2 px-2 text-[13px] font-normal"
          >
            <Plus size={13} className="text-muted-foreground" aria-hidden />
            New project
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
