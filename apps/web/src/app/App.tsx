import { useEffect } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/components/chat/ChatView";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { TerminalPanel } from "@/components/terminal";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { initShortcuts, registerShortcut } from "@/lib/shortcuts";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";

/** Root application component. Initializes WS transport and push listeners. */
export function App() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);

  useEffect(() => {
    startPushListeners();
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

    return () => {
      cleanup();
      unregCmdK();
      unregEscape();
      unregCtrlJ();
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
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <ConnectionBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <main className="flex-1 overflow-hidden">
            <ChatView />
          </main>
          <TerminalPanel />
        </div>
      </div>
    </div>
  );
}
