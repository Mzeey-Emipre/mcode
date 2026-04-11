import { useMemo } from "react";
import { SectionHeading } from "../SectionHeading";
import { SettingRow } from "../SettingRow";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands } from "@/lib/command-registry";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { useToastStore } from "@/stores/toastStore";
import { isMac, isWindows } from "@/lib/platform";

/** Settings section showing keyboard shortcuts and the path to the user override file. */
export function KeyboardShortcutsSection() {
  const setShortcutHelpOpen = useUiStore((s) => s.setShortcutHelpOpen);

  const configPath = isWindows
    ? "%USERPROFILE%\\.mcode\\keybindings.json"
    : "~/.mcode/keybindings.json";

  const boundCommands = useMemo(() => {
    const commands = getAllCommands().filter((c) => c.id !== "escape.handle");
    return commands.filter((c) => getKeybindingForCommand(c.id));
  }, []);

  const hasDesktopBridge = !!window.desktopBridge;

  const handleOpenKeybindings = () => {
    if (!window.desktopBridge) {
      useToastStore
        .getState()
        .show("error", "Desktop integration unavailable", "Keybindings cannot be opened in this environment");
      return;
    }
    window.desktopBridge.openKeybindingsFile().catch((err) => {
      useToastStore
        .getState()
        .show("error", "Could not open keybindings file", String(err?.message ?? err));
    });
  };

  return (
    <div>
      <SectionHeading>Keyboard Shortcuts</SectionHeading>

      <SettingRow
        label="Custom keybindings"
        hint={`Override default shortcuts by editing ${configPath}.`}
      >
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasDesktopBridge}
            onClick={handleOpenKeybindings}
          >
            Edit keybindings.json
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShortcutHelpOpen(true)}
          >
            View All Shortcuts
          </Button>
        </div>
      </SettingRow>

      <div className="mt-4 space-y-1">
        {boundCommands.map((cmd) => {
          const binding = getKeybindingForCommand(cmd.id)!;
          return (
            <div
              key={cmd.id}
              className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm"
            >
              <span className="text-foreground/80">{cmd.title}</span>
              <kbd className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {formatKeybinding(binding.key, isMac)}
              </kbd>
            </div>
          );
        })}
      </div>
    </div>
  );
}
