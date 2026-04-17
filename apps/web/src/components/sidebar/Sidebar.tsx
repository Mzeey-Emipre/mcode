import { ProjectTree } from "./ProjectTree";
import { PanelLeftClose, PanelLeft, Settings, ArrowLeft, ExternalLink, Braces } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsNav } from "@/components/settings/SettingsNav";
import type { SettingsSection } from "@/components/settings/settings-nav";
import { SidebarUsagePanel } from "./SidebarUsagePanel";

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
  const [collapsed, setCollapsed] = useState(false);

  // Force-expand sidebar when settings is open
  const isCollapsed = collapsed && !settingsOpen;


  const handleEditJson = () => {
    if (window.desktopBridge) {
      void window.desktopBridge.openSettingsFile();
    }
  };

  return (
    <div
      className={cn(
        "flex h-full flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        isCollapsed ? "w-12" : "w-72",
      )}
    >
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        {settingsOpen && !isCollapsed ? (
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
            {!isCollapsed && (
              <span className="text-sm font-semibold tracking-tight text-foreground">Mcode</span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="text-muted-foreground"
            >
              {isCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          </>
        )}
      </div>

      {/* Body */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto">
          {settingsOpen && settingsSection && onSettingsSection ? (
            <SettingsNav section={settingsSection} onSection={onSettingsSection} />
          ) : (
            <ProjectTree />
          )}
        </div>
      )}

      {/* Footer */}
      {!isCollapsed && (
        <div className="border-t border-border p-3 space-y-1">
          {!settingsOpen && <SidebarUsagePanel />}
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
      )}
    </div>
  );
}
