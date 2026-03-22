import { useEffect } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/components/chat/ChatView";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { initShortcuts, registerShortcut } from "@/lib/shortcuts";

export function App() {
  const theme = useSettingsStore((s) => s.theme);

  // Keyboard shortcuts
  useEffect(() => {
    const cleanup = initShortcuts();

    const unregCmdK = registerShortcut({
      key: "k",
      ctrl: true,
      description: "Open command palette",
      handler: () => console.log("Command palette (placeholder)"),
    });

    const unregEscape = registerShortcut({
      key: "Escape",
      description: "Deselect thread",
      handler: () => useWorkspaceStore.getState().setActiveThread(null),
    });

    return () => {
      cleanup();
      unregCmdK();
      unregEscape();
    };
  }, []);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)"
      ).matches;
      root.classList.toggle("dark", prefersDark);
    } else {
      root.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <ChatView />
      </main>
    </div>
  );
}
