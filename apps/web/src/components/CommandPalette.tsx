import { useEffect, useCallback, useMemo } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands, executeCommand } from "@/lib/command-registry";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { setContext } from "@/lib/context-tracker";
import { isMac } from "@/lib/platform";

/**
 * Top-center floating command palette overlay.
 * Lists all registered commands grouped by category with inline shortcut display.
 * Uses cmdk for fuzzy search filtering and @base-ui Dialog for focus trapping.
 */
export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);

  // Keep context tracker in sync
  useEffect(() => {
    setContext("commandPaletteOpen", open);
  }, [open]);

  const commands = useMemo(() => {
    if (!open) return [];
    const all = getAllCommands();
    // Don't show internal commands in the palette
    const hidden = new Set(["escape.handle"]);
    return all.filter((c) => !hidden.has(c.id));
  }, [open]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof commands>();
    for (const cmd of commands) {
      const group = map.get(cmd.category) ?? [];
      group.push(cmd);
      map.set(cmd.category, group);
    }
    return map;
  }, [commands]);

  const handleSelect = useCallback(
    (commandId: string) => {
      setOpen(false);
      // Defer execution so the palette closes before the command runs
      // (avoids focus conflicts with dialogs the command might open)
      requestAnimationFrame(() => {
        executeCommand(commandId);
      });
    },
    [setOpen],
  );

  const categories = Array.from(grouped.keys()).sort();

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal="trap-focus">
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Popup className="fixed left-1/2 top-[clamp(4rem,15vh,9rem)] z-50 w-full max-w-lg -translate-x-1/2 outline-none">
          <Command
            className="rounded-lg border border-border bg-popover shadow-2xl"
            loop
          >
            <CommandInput placeholder="Type a command..." autoFocus />
            <CommandList className="max-h-80">
              <CommandEmpty>No commands found.</CommandEmpty>
              {categories.map((category, i) => (
                <div key={category}>
                  {i > 0 && <CommandSeparator />}
                  <CommandGroup heading={category}>
                    {grouped.get(category)!.map((cmd) => {
                      const binding = getKeybindingForCommand(cmd.id);
                      return (
                        <CommandItem
                          key={cmd.id}
                          value={`${cmd.title} ${cmd.category}`}
                          onSelect={() => handleSelect(cmd.id)}
                        >
                          <span className="flex-1">{cmd.title}</span>
                          {binding && (
                            <kbd className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {formatKeybinding(binding.key, isMac)}
                            </kbd>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </div>
              ))}
            </CommandList>
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
