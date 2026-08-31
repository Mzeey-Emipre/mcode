import { ProjectTree, useWorkspaceStore } from "@/features/projects";
import {
  Settings,
  ArrowLeft,
  ExternalLink,
  Braces,
  Search,
  SquarePen,
  GitPullRequest,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsNav } from "@/components/settings/SettingsNav";
import type { SettingsSection } from "@/components/settings/settings-nav";
import { UpdateIndicator } from "./UpdateIndicator";
import { PanelCollapseIcon } from "./SidebarRevealButton";
import { useUiStore } from "@/stores/uiStore";
import { McodeLogo } from "@/components/brand/McodeLogo";
import { cn } from "@/lib/utils";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";

/** True when running inside the Electron shell. */
const IS_DESKTOP = typeof window !== "undefined" && !!window.desktopBridge;

interface SidebarProps {
  /** Optional sizing overrides supplied by the sidebar shell. */
  className?: string;
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

function SidebarTitle({ settingsOpen, onCloseSettings, onCollapse }: { settingsOpen: boolean | undefined; onCloseSettings: (() => void) | undefined; onCollapse: () => void }) {
  if (IS_DESKTOP && !settingsOpen) return null;
  return <div className="flex h-11 items-center justify-between border-b border-border/40 pl-2 pr-2.5">
    {settingsOpen ? <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" onClick={onCloseSettings} aria-label="Back to chat" className="text-muted-foreground"><ArrowLeft size={15} /></Button><span className="text-sm font-semibold text-muted-foreground">Settings</span></div> : <><McodeLogo /><Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Collapse sidebar" className="text-muted-foreground"><PanelCollapseIcon className="transition-transform duration-200 group-hover/button:-translate-x-px" /></Button></>}
  </div>;
}

function getSettingsNavProps(settingsOpen: boolean | undefined, settingsSection: SettingsSection | undefined, onSettingsSection: ((section: SettingsSection) => void) | undefined): { section: SettingsSection; onSection: (section: SettingsSection) => void } | null {
  return settingsOpen && settingsSection && onSettingsSection ? { section: settingsSection, onSection: onSettingsSection } : null;
}

function SidebarBody({ settingsOpen, settingsSection, onSettingsSection, primarySurface, onNewThread, onOpenThreadSearch, onOpenPullRequests }: { settingsOpen: boolean | undefined; settingsSection: SettingsSection | undefined; onSettingsSection: ((section: SettingsSection) => void) | undefined; primarySurface: string; onNewThread: () => void; onOpenThreadSearch: () => void; onOpenPullRequests: () => void }) {
  const settingsNavProps = getSettingsNavProps(settingsOpen, settingsSection, onSettingsSection);
  return <div data-testid="sidebar-body" className="flex min-h-0 flex-1 flex-col overflow-hidden">
    {settingsNavProps ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain"><SettingsNav {...settingsNavProps} /></div> : <><div className="grid shrink-0 gap-0.5 px-1.5 py-2">
      <Button variant="ghost" size="sm" className="h-8 justify-start gap-2 rounded-md px-1.5 text-[13px] font-normal text-muted-foreground shadow-none hover:text-foreground" onClick={onNewThread}><SquarePen size={15} aria-hidden />New thread</Button>
      <Button variant="ghost" size="sm" className="h-8 justify-start gap-2 rounded-md px-1.5 text-[13px] font-normal text-muted-foreground hover:text-foreground" onClick={onOpenThreadSearch}><Search size={15} aria-hidden />Search threads</Button>
      <Button variant="ghost" size="sm" aria-current={primarySurface === "pullRequests" ? "page" : undefined} className={cn("h-8 justify-start gap-2 rounded-md px-1.5 text-[13px] font-normal shadow-none", primarySurface === "pullRequests" ? "bg-accent/55 text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={onOpenPullRequests}><GitPullRequest size={15} aria-hidden />Pull requests</Button>
    </div><ProjectTree /></>}
  </div>;
}

function SidebarFooter({ settingsOpen, onOpenSettings, onEditSettings }: { settingsOpen: boolean | undefined; onOpenSettings: () => void; onEditSettings: () => void }) {
  return <div className="border-t border-border/40 p-3 space-y-1"><UpdateIndicator />
    {settingsOpen ? IS_DESKTOP && <Button variant="ghost" className="flex w-full items-center gap-2 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onEditSettings}><Braces size={14} />Edit settings.json<ExternalLink size={11} /></Button> : <Button variant="ghost" className="flex w-full items-center gap-2 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onOpenSettings}><Settings size={16} />Settings</Button>}
  </div>;
}

/** Sidebar component that renders app navigation, project tree, or settings nav. */
export function Sidebar({
  className,
  settingsOpen,
  settingsSection,
  onSettingsSection,
  onOpenSettings,
  onCloseSettings,
}: SidebarProps) {
  const collapseSidebar = useUiStore((s) => s.collapseSidebar);
  const primarySurface = useUiStore((s) => s.primarySurface);
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);

  const handleEditJson = () => {
    if (window.desktopBridge) {
      void window.desktopBridge.openSettingsFile();
    }
  };

  return (
    <div className={cn("flex h-full flex-col bg-page", settingsOpen ? "w-40 max-w-[42vw] sm:w-56 md:w-72 md:max-w-none" : "w-72 max-w-[55vw] md:max-w-none", className)}>
      <SidebarTitle settingsOpen={settingsOpen} onCloseSettings={onCloseSettings} onCollapse={collapseSidebar} />
      <SidebarBody settingsOpen={settingsOpen} settingsSection={settingsSection} onSettingsSection={onSettingsSection} primarySurface={primarySurface} onNewThread={() => { setPrimarySurface("chat"); useWorkspaceStore.getState().beginNewThread(); }} onOpenThreadSearch={() => useCommandPaletteStore.getState().open({ intent: "threadSearch" })} onOpenPullRequests={() => setPrimarySurface("pullRequests")} />
      <SidebarFooter settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} onEditSettings={handleEditJson} />
    </div>
  );
}
