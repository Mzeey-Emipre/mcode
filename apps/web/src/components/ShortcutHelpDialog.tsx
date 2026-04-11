import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands } from "@/lib/command-registry";
import {
  getKeybindingForCommand,
  formatKeybinding,
} from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";

/**
 * Full-screen dialog showing all keyboard shortcuts grouped by category.
 * Accessible via Cmd+? or from the command palette.
 */
export function ShortcutHelpDialog() {
  const open = useUiStore((s) => s.shortcutHelpOpen);
  const setOpen = useUiStore((s) => s.setShortcutHelpOpen);

  const grouped = useMemo(() => {
    if (!open) return new Map<string, Array<{ title: string; shortcut: string }>>();

    const all = getAllCommands();
    // Escape handler is an internal command, not meaningful to surface to users.
    const hidden = new Set(["escape.handle"]);
    const map = new Map<string, Array<{ title: string; shortcut: string }>>();

    for (const cmd of all) {
      if (hidden.has(cmd.id)) continue;
      const binding = getKeybindingForCommand(cmd.id);
      if (!binding) continue; // only show commands that have shortcuts

      const group = map.get(cmd.category) ?? [];
      group.push({
        title: cmd.title,
        shortcut: formatKeybinding(binding.key, isMac),
      });
      map.set(cmd.category, group);
    }

    return map;
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
      <DialogContent className="max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {Array.from(grouped.keys())
            .sort()
            .map((category) => (
              <div key={category}>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {category}
                </h3>
                <div className="space-y-1">
                  {grouped.get(category)!.map((item) => (
                    <div
                      key={item.title}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm"
                    >
                      <span>{item.title}</span>
                      <kbd className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {item.shortcut}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
