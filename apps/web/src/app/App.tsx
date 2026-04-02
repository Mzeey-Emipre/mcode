import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/components/chat/ChatView";
import { SettingsView } from "@/components/settings/SettingsView";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { TerminalPanel } from "@/components/terminal";
import { TaskPanel } from "@/components/tasks";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { useTaskStore } from "@/stores/taskStore";
import { initShortcuts, registerShortcut } from "@/lib/shortcuts";
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
  useIdleReclamation();

  useEffect(() => {
    startPushListeners();
    useSettingsStore.getState().fetch();
    return () => stopPushListeners();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const cleanup = initShortcuts();

    const unregCmdK = registerShortcut({
      key: "k",
      ctrl: true,
      description: "Open command palette",
      handler: () => {
        // TODO: command palette
      },
    });

    const unregEscape = registerShortcut({
      key: "Escape",
      description: "Deselect thread",
      handler: () => useWorkspaceStore.getState().setActiveThread(null),
    });

    const unregCtrlJ = registerShortcut({
      key: "j",
      ctrl: true,
      description: "Toggle terminal panel",
      handler: () => useTerminalStore.getState().togglePanel(),
    });

    const unregCtrlT = registerShortcut({
      key: "t",
      ctrl: true,
      description: "Toggle task panel",
      handler: () => useTaskStore.getState().togglePanel(),
    });

    return () => {
      cleanup();
      unregCmdK();
      unregEscape();
      unregCtrlJ();
      unregCtrlT();
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
          <Sidebar
            settingsOpen={settingsOpen}
            settingsSection={settingsSection}
            onSettingsSection={setSettingsSection}
            onOpenSettings={() => setSettingsOpen(true)}
            onCloseSettings={() => setSettingsOpen(false)}
          />
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex flex-1 overflow-hidden">
              <main className="flex-1 overflow-hidden">
                {settingsOpen ? (
                  <SettingsView section={settingsSection} />
                ) : (
                  <ChatView />
                )}
              </main>
              {!settingsOpen && <TaskPanel />}
            </div>
            {!settingsOpen && <TerminalPanel />}
          </div>
        </div>
      </div>
      <ToastContainer />
    </TooltipProvider>
  );
}
