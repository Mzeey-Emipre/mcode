import { SectionHeading } from "../SectionHeading";
import { SettingRow } from "../SettingRow";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands } from "@/lib/command-registry";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";

const isMac = navigator.platform.toUpperCase().includes("MAC");

/** Settings section showing keyboard shortcuts and the path to the user override file. */
export function KeyboardShortcutsSection() {
  const setShortcutHelpOpen = useUiStore((s) => s.setShortcutHelpOpen);

  const configPath = isMac
    ? "~/.mcode/keybindings.json"
    : "%USERPROFILE%\\.mcode\\keybindings.json";

  const commands = getAllCommands().filter((c) => c.id !== "escape.handle");
  const boundCommands = commands.filter((c) => getKeybindingForCommand(c.id));

  return (
    <div>
      <SectionHeading>Keyboard Shortcuts</SectionHeading>

      <SettingRow
        label="Custom keybindings"
        hint={`Create ${configPath} to override default shortcuts. The file uses the same format as the built-in defaults.`}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShortcutHelpOpen(true)}
        >
          View All Shortcuts
        </Button>
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
