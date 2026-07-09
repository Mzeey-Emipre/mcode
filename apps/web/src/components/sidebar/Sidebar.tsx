import { ProjectTree } from "./ProjectTree";
import { Settings, ArrowLeft, ExternalLink, Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsNav } from "@/components/settings/SettingsNav";
import type { SettingsSection } from "@/components/settings/settings-nav";
import { UpdateIndicator } from "./UpdateIndicator";
import { PanelCollapseIcon } from "./SidebarRevealButton";
import { useUiStore } from "@/stores/uiStore";
import { McodeLogo } from "@/components/brand/McodeLogo";
import { cn } from "@/lib/utils";

/** True when running inside the Electron shell. */
const IS_DESKTOP = typeof window !== "undefined" && !!window.desktopBridge;

interface SidebarProps {
  /** Whether the settings view is active. */
  settingsOpen?: boolean;
  /** Active settings section. */
  settingsSection?: SettingsSection;
  /** Called when the user selects a settings section. */
  onSettingsSection?: (s: SettingsSection) => void;
  /** Called when the user clicks the Settings button. */
  onOpenSettings: () => void;
  /** Called when the user clicks back from settings. */
  onCloseSettings?: () => void;
}

/** Sidebar component that renders app navigation, project tree, or settings nav. */
export function Sidebar({
  settingsOpen,
  settingsSection,
  onSettingsSection,
  onOpenSettings,
  onCloseSettings,
}: SidebarProps) {
  const collapseSidebar = useUiStore((s) => s.collapseSidebar);

  const handleEditJson = () => {
    if (window.desktopBridge) {
      void window.desktopBridge.openSettingsFile();
    }
  };

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-page",
        settingsOpen
          ? "w-40 max-w-[42vw] sm:w-56 md:w-72 md:max-w-none"
          : "w-72 max-w-[55vw] md:max-w-none",
      )}
    >
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border/40 pl-2 pr-2.5">
        {settingsOpen ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onCloseSettings}
              aria-label="Back to projects"
              className="text-muted-foreground"
            >
              <ArrowLeft size={15} />
            </Button>
            <span className="text-sm font-semibold text-muted-foreground">Settings</span>
          </div>
        ) : (
          <>
            <McodeLogo />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => collapseSidebar()}
              aria-label="Collapse sidebar"
              className="text-muted-foreground"
            >
              <PanelCollapseIcon className="transition-transform duration-200 group-hover/button:-translate-x-px" />
            </Button>
          </>
        )}
      </div>

      {/* Body: projects use an inner ScrollArea only; avoid stacking overflow-y-auto
          here or drag transforms and autoscroll can expand this region and show a
          scrollbar when the list is short. Settings stays scrollable. */}
      <div
        data-testid="sidebar-body"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {settingsOpen && settingsSection && onSettingsSection ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <SettingsNav section={settingsSection} onSection={onSettingsSection} />
          </div>
        ) : (
          <ProjectTree />
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border/40 p-3 space-y-1">
        <UpdateIndicator />
        {settingsOpen ? (
          IS_DESKTOP && (
            <Button
              variant="ghost"
              className="flex w-full items-center gap-2 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleEditJson}
            >
              <Braces size={14} />
              Edit settings.json
              <ExternalLink size={11} />
            </Button>
          )
        ) : (
          <Button
            variant="ghost"
            className="flex w-full items-center gap-2 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onOpenSettings}
          >
            <Settings size={16} />
            Settings
          </Button>
        )}
      </div>
    </div>
  );
}
