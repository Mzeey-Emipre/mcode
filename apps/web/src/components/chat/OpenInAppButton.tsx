import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { getTransport } from "@/transport";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { registerCommand } from "@/lib/command-registry";
import { formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { resolveDefaultOpenInApp, FILE_EXPLORER_ID } from "@/lib/resolveDefaultOpenInApp";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openInAppIcon } from "./openInAppIcons";

/** Props for {@link OpenInAppButton}. */
interface OpenInAppButtonProps {
  /** Absolute path to open, or null when the thread has no workspace (disabled state). */
  dirPath: string | null;
  /** Thread whose per-thread default this button reads and writes. */
  threadId: string;
  /** Thread-level override app id (tier 1), or null to inherit the global / auto default. */
  threadOverride: string | null;
}

/**
 * Split button that opens the thread's directory in its resolved default app.
 *
 * The primary segment and `mod+o` both open the three-tier resolved default
 * (thread override -> global setting -> auto-detected editor -> File Explorer).
 * The caret lists installed apps; picking one opens it and writes the choice as
 * this thread's override only, never touching the global setting.
 */
export function OpenInAppButton({ dirPath, threadId, threadOverride }: OpenInAppButtonProps) {
  const apps = useOpenInApps();
  const globalDefault = useSettingsStore((s) => s.settings.externalApps.defaultEditor || null);
  const setThreadSettings = useThreadStore((s) => s.setThreadSettings);
  const [menuOpen, setMenuOpen] = useState(false);

  const installed = apps.filter((app) => app.detected);
  const resolvedId = resolveDefaultOpenInApp(threadOverride, globalDefault, apps);
  const resolvedApp = apps.find((app) => app.id === resolvedId);
  const resolvedLabel = resolvedApp?.label ?? "File Explorer";
  const disabled = dirPath == null;

  const openApp = useCallback(
    (appId: string) => {
      if (dirPath == null) return;
      const label = apps.find((app) => app.id === appId)?.label ?? appId;
      getTransport()
        .openIn(appId, dirPath)
        .catch((err) =>
          useToastStore.getState().show("error", `Could not open ${label}`, String(err?.message ?? err)),
        );
    },
    [apps, dirPath],
  );

  const openDefault = useCallback(() => {
    openApp(resolvedId);
  }, [openApp, resolvedId]);

  const pickApp = (appId: string) => {
    openApp(appId);
    void setThreadSettings(threadId, { defaultOpenInApp: appId });
  };

  // mod+o opens the resolved default. Skip registration while disabled so the
  // shortcut is inert with no workspace, matching the dimmed button.
  useEffect(() => {
    if (disabled) return;
    return registerCommand({
      id: "openin.openDefault",
      title: `Open in ${resolvedLabel}`,
      category: "View",
      handler: openDefault,
    });
  }, [disabled, openDefault, resolvedLabel]);

  const shortcut = formatKeybinding("mod+o", isMac);

  return (
    <div className="relative inline-flex">
      <div className="inline-flex rounded">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6 rounded-r-none"
                onClick={openDefault}
                disabled={disabled}
                aria-label={`Open in ${resolvedLabel}`}
              >
                {openInAppIcon(resolvedApp?.iconKey ?? FILE_EXPLORER_ID, 14)}
                <span>Open</span>
              </Button>
            }
          />
          <TooltipContent side="bottom" className="text-xs">
            {disabled ? "No workspace to open" : `Open in ${resolvedLabel} (${shortcut})`}
          </TooltipContent>
        </Tooltip>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            aria-label="Choose app to open in"
            disabled={disabled}
            className={cn(
              "inline-flex items-center px-1 h-6 text-xs border-l border-border/20 rounded-r transition-colors outline-none",
              "text-foreground/70 hover:text-foreground hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:opacity-50 disabled:pointer-events-none",
            )}
          >
            <ChevronDown
              size={12}
              className={cn("transition-transform duration-150", menuOpen && "rotate-180")}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-[170px] text-xs">
            {installed.map((app) => (
              <DropdownMenuItem
                key={app.id}
                onClick={() => pickApp(app.id)}
                className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-xs"
              >
                <span className="flex items-center gap-2">
                  {openInAppIcon(app.iconKey, 16)}
                  <span>{app.label}</span>
                </span>
                {app.id === resolvedId && <Check size={14} className="opacity-75" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
