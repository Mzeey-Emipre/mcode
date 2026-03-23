import { useEffect } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/components/chat/ChatView";
import { TerminalPanel } from "@/components/terminal";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { initShortcuts, registerShortcut } from "@/lib/shortcuts";
import { startListening, stopListening } from "@/transport/events";

export function App() {
  const theme = useSettingsStore((s) => s.theme);

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

  // Agent event streaming
  useEffect(() => {
    const handleEvent = useThreadStore.getState().handleAgentEvent;
    startListening((event) => {
      handleEvent(event.thread_id, event.event);
    });
    return () => stopListening();
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
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-hidden">
          <ChatView />
        </main>
        <TerminalPanel />
      </div>
    </div>
  );
}
