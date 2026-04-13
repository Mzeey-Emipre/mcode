import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/components/chat/ChatView";
import { SettingsView } from "@/components/settings/SettingsView";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { TerminalPanel } from "@/components/terminal";
import { RightPanel } from "@/components/panels/RightPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutHelpDialog } from "@/components/ShortcutHelpDialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { initShortcuts } from "@/lib/shortcuts";
import { registerCommand } from "@/lib/command-registry";
import { setContext } from "@/lib/context-tracker";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { useIdleReclamation } from "@/hooks/useIdleReclamation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastContainer } from "@/components/Toast";
import type { SettingsSection } from "@/components/settings/settings-nav";

/** Root application component. Initializes WS transport and push listeners. */
export function App() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("model");
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  useIdleReclamation();

  useEffect(() => {
    startPushListeners();
    useSettingsStore.getState().fetch();
    return () => stopPushListeners();
  }, []);

  // Listen for deep-link requests to open a specific settings section
  useEffect(() => {
    const handler = (e: Event) => {
      const section = (e as CustomEvent<{ section: SettingsSection }>).detail?.section ?? "model";
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener("mcode:open-settings", handler);
    return () => window.removeEventListener("mcode:open-settings", handler);
  }, []);

  // Keep settingsOpen context in sync
  useEffect(() => {
    setContext("settingsOpen", settingsOpen);
  }, [settingsOpen]);

  // Register all commands and initialize shortcuts
  useEffect(() => {
    const cleanup = initShortcuts();

    const disposers = [
      registerCommand({
        id: "commandPalette.toggle",
        title: "Command Palette",
        category: "General",
        handler: () => {
          const store = useUiStore.getState();
          store.setCommandPaletteOpen(!store.commandPaletteOpen);
        },
      }),
      registerCommand({
        id: "escape.handle",
        title: "Escape",
        category: "General",
        handler: () => {
          const ui = useUiStore.getState();
          if (ui.commandPaletteOpen) {
            ui.setCommandPaletteOpen(false);
          } else if (ui.shortcutHelpOpen) {
            ui.setShortcutHelpOpen(false);
          } else {
            useWorkspaceStore.getState().setActiveThread(null);
          }
        },
      }),
      registerCommand({
        id: "thread.new",
        title: "New Thread",
        category: "Thread",
        handler: () => {
          useWorkspaceStore.getState().setPendingNewThread(true);
        },
      }),
      registerCommand({
        id: "workspace.new",
        title: "New Workspace",
        category: "Workspace",
        handler: () => {
          window.dispatchEvent(new CustomEvent("mcode:new-workspace"));
        },
      }),
      registerCommand({
        id: "sidebar.toggle",
        title: "Toggle Sidebar",
        category: "View",
        handler: () => useUiStore.getState().toggleSidebar(),
      }),
      registerCommand({
        id: "terminal.toggle",
        title: "Toggle Terminal",
        category: "View",
        handler: () => {
          const tid = useWorkspaceStore.getState().activeThreadId;
          if (tid) useTerminalStore.getState().toggleTerminalPanel(tid);
        },
      }),
      registerCommand({
        id: "settings.open",
        title: "Open Settings",
        category: "General",
        handler: () => {
          window.dispatchEvent(
            new CustomEvent("mcode:open-settings", {
              detail: { section: "model" },
            }),
          );
        },
      }),
      registerCommand({
        id: "shortcuts.help",
        title: "Keyboard Shortcuts",
        category: "General",
        handler: () => {
          const store = useUiStore.getState();
          store.setShortcutHelpOpen(!store.shortcutHelpOpen);
        },
      }),
      registerCommand({
        id: "tasks.toggle",
        title: "Toggle Tasks Panel",
        category: "View",
        handler: () => {
          const tid = useWorkspaceStore.getState().activeThreadId;
          if (!tid) return;
          const { getRightPanel, showRightPanel, setRightPanelTab, hideRightPanel } =
            useDiffStore.getState();
          const panel = getRightPanel(tid);
          if (!panel.visible) {
            showRightPanel(tid);
            setRightPanelTab(tid, "tasks");
          } else if (panel.activeTab !== "tasks") {
            setRightPanelTab(tid, "tasks");
          } else {
            hideRightPanel(tid);
          }
        },
      }),
      registerCommand({
        id: "changes.toggle",
        title: "Toggle Changes Panel",
        category: "View",
        handler: () => {
          const tid = useWorkspaceStore.getState().activeThreadId;
          if (!tid) return;
          const { getRightPanel, showRightPanel, setRightPanelTab, hideRightPanel } =
            useDiffStore.getState();
          const panel = getRightPanel(tid);
          if (!panel.visible) {
            showRightPanel(tid);
            setRightPanelTab(tid, "changes");
          } else if (panel.activeTab !== "changes") {
            setRightPanelTab(tid, "changes");
          } else {
            hideRightPanel(tid);
          }
        },
      }),
      // Thread switching: Cmd+1 through Cmd+9
      ...Array.from({ length: 9 }, (_, i) =>
        registerCommand({
          id: `thread.goTo${i + 1}`,
          title: `Go to Thread ${i + 1}`,
          category: "Thread",
          handler: () => {
            const threads = useWorkspaceStore.getState().threads;
            if (threads[i]) {
              useWorkspaceStore.getState().setActiveThread(threads[i].id);
            }
          },
        }),
      ),
    ];

    return () => {
      cleanup();
      disposers.forEach((d) => d());
    };
  }, []);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = (dark: boolean) => root.classList.toggle("dark", dark);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(mq.matches);
      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    } else {
      applyTheme(theme === "dark");
    }
  }, [theme]);

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <ConnectionBanner />
        <div className="flex flex-1 overflow-hidden">
          {!sidebarCollapsed && (
            <Sidebar
              settingsOpen={settingsOpen}
              settingsSection={settingsSection}
              onSettingsSection={setSettingsSection}
              onOpenSettings={() => setSettingsOpen(true)}
              onCloseSettings={() => setSettingsOpen(false)}
            />
          )}
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex flex-1 overflow-hidden">
              <main className="flex-1 overflow-hidden">
                {settingsOpen ? (
                  <SettingsView section={settingsSection} />
                ) : (
                  <ChatView />
                )}
              </main>
              {!settingsOpen && <RightPanel />}
            </div>
            {!settingsOpen && <TerminalPanel />}
          </div>
        </div>
      </div>
      <CommandPalette />
      <ShortcutHelpDialog />
      <ToastContainer />
    </TooltipProvider>
  );
}
