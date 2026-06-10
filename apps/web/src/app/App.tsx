import { useEffect, useState, lazy, Suspense } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/components/chat/ChatView";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { useUpdateStore } from "@/stores/updateStore";
import { useToastStore } from "@/stores/toastStore";
import { friendlyUpdateError } from "@/lib/update-error-message";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { ProjectSelectorLanding } from "@/components/projects/ProjectSelectorLanding";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { ShortcutHelpDialog } from "@/components/ShortcutHelpDialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { resizeRecordCache } from "@/lib/thread-hydrator/record-cache";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { usePreviewFocusStore } from "@/stores/previewFocusStore";
import { useUiStore } from "@/stores/uiStore";
import { initShortcuts } from "@/lib/shortcuts";
import { summonTab } from "@/lib/summon-tab";
import { registerCommand } from "@/lib/command-registry";
import { setContext } from "@/lib/context-tracker";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { useIdleReclamation } from "@/hooks/useIdleReclamation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastContainer } from "@/components/Toast";
import type { SettingsSection } from "@/components/settings/settings-nav";
import { TerminalPoolHost } from "@/components/terminal/TerminalPoolHost";
import { TerminalPoolSlotProvider } from "@/components/terminal/TerminalPoolSlotContext";

const LazySettingsView = lazy(async () => {
  const m = await import("@/components/settings/SettingsView");
  return { default: m.SettingsView };
});


const LazyRightPanel = lazy(async () => {
  const m = await import("@/components/panels/RightPanel");
  return { default: m.RightPanel };
});

const LazyCommandPalette = lazy(async () => {
  const m = await import("@/components/palette/CommandPalette");
  return { default: m.CommandPalette };
});

// THROWAWAY: right-panel revamp prototype, reachable via ?prototype=panel. Delete with the prototype.
const LazyRightPanelPrototype = lazy(async () => {
  const m = await import("@/components/prototype/RightPanelPrototype");
  return { default: m.RightPanelPrototype };
});

// THROWAWAY: browser-view prototype, reachable via ?prototype=browser. Delete with the prototype.
const LazyBrowserViewPrototype = lazy(async () => {
  const m = await import("@/components/prototype/BrowserViewPrototype");
  return { default: m.BrowserViewPrototype };
});

// THROWAWAY: chat-header prototype, reachable via ?prototype=header. Delete with the prototype.
const LazyHeaderPrototype = lazy(async () => {
  const m = await import("@/components/prototype/HeaderPrototype");
  return { default: m.HeaderPrototype };
});

/** Root application component. Initializes WS transport and push listeners. */
export function App() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const threadCacheSize = useSettingsStore((s) => s.settings.performance.threadCacheSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("model");
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const pendingNewThread = useWorkspaceStore((s) => s.pendingNewThread);
  // Landing is the default whenever no thread is active. The new-thread composer
  // takes precedence so the user can compose against an active workspace without
  // bouncing back to the project list.
  const showLanding = activeThreadId === null && !pendingNewThread;
  useIdleReclamation();

  useEffect(() => {
    startPushListeners();
    useSettingsStore.getState().fetch();
    return () => stopPushListeners();
  }, []);

  // Mirror the user-controlled record-cache capacity (threadCacheSize) into the runtime cache.
  // Runs on every settings change; LruCache.resize is a no-op when capacity is unchanged.
  useEffect(() => {
    resizeRecordCache(threadCacheSize);
  }, [threadCacheSize]);

  // Hydrate app version + auto-updater status from the Electron preload bridge.
  useEffect(() => {
    const bridge = window.desktopBridge?.app;
    if (!bridge) return;

    void bridge.getVersion().then((v) => useUpdateStore.getState().setVersion(v));
    void bridge.getUpdateStatus().then((s) => {
      if (s && useUpdateStore.getState().status.state === "idle") {
        useUpdateStore.getState().setStatus(s as UpdateStatus);
      }
    });

    const listener = bridge.onUpdateStatus((status) => {
      // Errors are rare and recoverable (a genuine update failure, not a
      // transient gateway blip — those are filtered in the main process). A
      // non-blocking toast states what happened without a persistent red bar.
      if (status.state === "error") {
        const friendly = friendlyUpdateError(status.message);
        useToastStore.getState().show("error", friendly.title, friendly.body);
      }
      useUpdateStore.getState().setStatus(status);
    });
    return () => bridge.offUpdateStatus(listener);
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

  // Landing-only shortcuts (e.g. mod+Enter for new project) should not fire
  // when settings covers the main pane or chat is visible.
  useEffect(() => {
    setContext("showLanding", showLanding && !settingsOpen);
  }, [showLanding, settingsOpen]);

  // Register all commands and initialize shortcuts
  useEffect(() => {
    const cleanup = initShortcuts();

    const disposers = [
      registerCommand({
        id: "palette.open",
        title: "Open Command Palette",
        category: "Navigation",
        handler: () => useCommandPaletteStore.getState().open(),
      }),
      // Backward-compat alias — mod+p still opens the palette
      registerCommand({
        id: "commandPalette.toggle",
        title: "Command Palette",
        category: "General",
        handler: () => {
          const palette = useCommandPaletteStore.getState();
          if (palette.isOpen) palette.close();
          else palette.open();
        },
      }),
      registerCommand({
        id: "escape.handle",
        title: "Escape",
        category: "General",
        handler: () => {
          const palette = useCommandPaletteStore.getState();
          if (palette.isOpen) {
            palette.close();
            return;
          }
          const ui = useUiStore.getState();
          if (ui.shortcutHelpOpen) {
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
          useCommandPaletteStore.getState().open({
            intent: "projects",
            nextAction: "newThread",
          });
        },
      }),
      registerCommand({
        // Command id stays `workspace.new` for shortcut/persistence stability
        // even though the user-facing label is now "New Project".
        id: "workspace.new",
        title: "New Project",
        category: "Project",
        handler: () => {
          // Reuse the same browse-mode entry the landing's "+ Add project"
          // button uses, instead of the previous orphan custom event.
          useCommandPaletteStore.getState().open({ intent: "addProject" });
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
        // Terminal creation on open is handled by RightPanel's
        // ensureTerminalForScope effect (fires for every open path).
        handler: () => summonTab("terminal"),
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
        title: "Toggle Scope Panel",
        category: "View",
        // Scope is thread-only; summonTab no-ops when there is no thread.
        handler: () => summonTab("tasks"),
      }),
      registerCommand({
        id: "changes.toggle",
        title: "Toggle Changes Panel",
        category: "View",
        handler: () => summonTab("changes"),
      }),
      registerCommand({
        id: "preview.toggle",
        title: "Toggle Preview Panel",
        category: "View",
        // Pull focus into the URL field on open/refocus so the user can type a
        // URL immediately after summoning the Browser by shortcut.
        handler: () =>
          summonTab("preview", () =>
            usePreviewFocusStore.getState().requestOmniboxFocus(),
          ),
      }),
      registerCommand({
        id: "preview.guestDevTools.open",
        title: "Open Guest Page DevTools",
        category: "View",
        handler: () => {
          void window.desktopBridge?.preview.openGuestDevTools();
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

  // THROWAWAY: short-circuit to the right-panel prototype. Placed after all hooks
  // so hook order is unaffected. Remove when the prototype is folded in or deleted.
  const protoSurface = new URLSearchParams(window.location.search).get("prototype");
  if (import.meta.env.DEV && (protoSurface === "panel" || protoSurface === "browser" || protoSurface === "header")) {
    // Seed the variant from the URL eagerly — before transport init reloads to add
    // ?token= (which drops ?variant=). The lazy prototype then reads it from storage.
    const protoVariant = new URLSearchParams(window.location.search).get("variant");
    if (protoVariant === "A" || protoVariant === "B" || protoVariant === "C") {
      sessionStorage.setItem("proto-variant", protoVariant);
    }
    return (
      <Suspense fallback={null}>
        {protoSurface === "browser" ? (
          <LazyBrowserViewPrototype />
        ) : protoSurface === "header" ? (
          <LazyHeaderPrototype />
        ) : (
          <LazyRightPanelPrototype />
        )}
      </Suspense>
    );
  }

  return (
    <TerminalPoolSlotProvider>
    <TooltipProvider delay={400}>
      {/* Floating-panel layout: page chrome is a darker tone (--page) with small
          gaps between panels. Each panel renders as a rounded surface that
          appears lifted off the chrome — no inter-panel divider lines required. */}
      <div className="flex h-screen flex-col overflow-hidden bg-page text-foreground">
        <ConnectionBanner />
        <div className="flex flex-1 gap-1.5 overflow-hidden p-1.5">
          {/* Settings view force-expands the sidebar so the settings nav is reachable.
              When the sidebar is hidden, the chat panel claims the full width and the
              reveal button lives inline in the chat header (see ChatView). */}
          {(!sidebarCollapsed || settingsOpen) && (
            <div className="flex shrink-0 overflow-hidden rounded-lg shadow-sm">
              <Sidebar
                settingsOpen={settingsOpen}
                settingsSection={settingsSection}
                onSettingsSection={setSettingsSection}
                onOpenSettings={() => setSettingsOpen(true)}
                onCloseSettings={() => setSettingsOpen(false)}
              />
            </div>
          )}
          <div className="flex flex-1 gap-1.5 overflow-hidden">
            <main className="flex-1 overflow-hidden rounded-lg bg-background shadow-sm">
              {settingsOpen ? (
                <Suspense fallback={null}>
                  <LazySettingsView section={settingsSection} />
                </Suspense>
              ) : showLanding ? (
                <div className="flex h-full flex-col">
                  {/* When the sidebar is collapsed, show the reveal button so the
                      user can re-expand it from the landing page. */}
                  {sidebarCollapsed && (
                    <div className="flex h-11 shrink-0 items-center px-2">
                      <SidebarRevealButton />
                    </div>
                  )}
                  <ProjectSelectorLanding />
                </div>
              ) : (
                <ChatView />
              )}
            </main>
            {!settingsOpen && !showLanding && (
              <Suspense fallback={null}>
                <LazyRightPanel />
              </Suspense>
            )}
          </div>
        </div>
      </div>
      <TerminalPoolHost />
      <Suspense fallback={null}>
        <LazyCommandPalette />
      </Suspense>
      <ShortcutHelpDialog />
      <ToastContainer />
    </TooltipProvider>
    </TerminalPoolSlotProvider>
  );
}
