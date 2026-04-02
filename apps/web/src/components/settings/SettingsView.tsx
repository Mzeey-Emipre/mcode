import { useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ModelSection } from "./sections/ModelSection";
import { AgentSection } from "./sections/AgentSection";
import { WorktreeSection } from "./sections/WorktreeSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { TerminalSection } from "./sections/TerminalSection";
import { ServerSection } from "./sections/ServerSection";

type SettingsSection =
  | "model"
  | "agent"
  | "worktree"
  | "appearance"
  | "notifications"
  | "terminal"
  | "server";

interface NavGroup {
  label: string;
  items: { id: SettingsSection; label: string }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "AI",
    items: [
      { id: "model", label: "Model" },
      { id: "agent", label: "Agent" },
      { id: "worktree", label: "Worktrees" },
    ],
  },
  {
    label: "Interface",
    items: [
      { id: "appearance", label: "Appearance" },
      { id: "notifications", label: "Notifications" },
      { id: "terminal", label: "Terminal" },
    ],
  },
  {
    label: "System",
    items: [{ id: "server", label: "Server" }],
  },
];

const SECTION_MAP: Record<SettingsSection, React.ReactNode> = {
  model: <ModelSection />,
  agent: <AgentSection />,
  worktree: <WorktreeSection />,
  appearance: <AppearanceSection />,
  notifications: <NotificationsSection />,
  terminal: <TerminalSection />,
  server: <ServerSection />,
};

interface SettingsViewProps {
  /** Called when the user clicks the back button. */
  onClose: () => void;
}

/**
 * Full-page settings view with sidebar navigation.
 * Replaces the main content area when open.
 */
export function SettingsView({ onClose }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("model");
  const isDesktop = typeof window !== "undefined" && !!window.desktopBridge;

  const handleEditJson = () => {
    if (window.desktopBridge) {
      void window.desktopBridge.openSettingsFile();
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <header className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Back to chat"
            className="text-muted-foreground"
          >
            <ArrowLeft size={15} />
          </Button>
          <span className="text-sm font-semibold text-muted-foreground">Settings</span>
        </div>
        {isDesktop && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleEditJson}
            className="gap-1.5 text-xs text-muted-foreground"
          >
            <span className="font-mono">{"{}"}</span>
            Edit settings.json
            <ExternalLink size={11} />
          </Button>
        )}
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Nav sidebar */}
        <nav className="w-44 flex-shrink-0 overflow-y-auto border-r border-border py-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4 px-2">
              <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                {group.label}
              </p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={cn(
                    "flex w-full rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors",
                    section === item.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[560px] px-8 py-7">{SECTION_MAP[section]}</div>
        </div>
      </div>
    </div>
  );
}
