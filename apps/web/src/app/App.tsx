import { useEffect, useState, useRef, lazy, Suspense } from "react";
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
import { COMPOSER_MIN_WIDTH } from "@/stores/diffStore";
import { usePreviewFocusStore } from "@/stores/previewFocusStore";
import { useUiStore } from "@/stores/uiStore";
import { initShortcuts } from "@/lib/shortcuts";
import { summonTab } from "@/lib/summon-tab";
import { registerCommand } from "@/lib/command-registry";
import { setContext } from "@/lib/context-tracker";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { useIdleReclamation } from "@/hooks/useIdleReclamation";
import { useComposerLayoutGuard } from "@/hooks/useComposerLayoutGuard";
import { toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
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

/** Root application component. Initializes WS transport and push listeners. */
export function App() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const threadCacheSize = useSettingsStore((s) => s.settings.performance.threadCacheSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("model");
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarFloating = useUiStore((s) => s.sidebarFloating);
  const rightPanelMaximized = useUiStore((s) => s.rightPanelMaximized);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const outerRowRef = useRef<HTMLDivElement>(null);
  const contentRowRef = useRef<HTMLDivElement>(null);
  const pendingNewThread = useWorkspaceStore((s) => s.pendingNewThread);
  // Landing is the default whenever no thread is active. The new-thread composer
  // takes precedence so the user can compose against an active workspace without
  // bouncing back to the project list.
  const showLanding = activeThreadId === null && !pendingNewThread;
  useIdleReclamation();

  useComposerLayoutGuard(outerRowRef, contentRowRef, {
    settingsOpen,
    showLanding,
    activeWorkspaceId,
    activeThreadId,
  });

  // Settings uses a docked project tree; undock the float when entering settings.
  useEffect(() => {
    if (settingsOpen) {
      useUiStore.setState({ sidebarFloating: false, sidebarCollapsed: false });
    }
  }, [settingsOpen]);

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
        id: "rightPanel.toggle",
        title: "Toggle Right Panel",
        category: "View",
        // Panel-level open/close (mirrors the chat-header toggle button); the
        // per-tab summon commands focus a specific tab, this just shows/hides the
        // whole panel for the active thread (or the threadless workspace shell).
        handler: () => {
          const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
          if (!activeWorkspaceId) return;
          toggleRightPanelAdaptive(activeWorkspaceId, activeThreadId);
        },
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

  return (
    <TerminalPoolSlotProvider>
    <TooltipProvider delay={400}>
      <div className="flex h-screen flex-col overflow-hidden bg-page text-foreground">
        <ConnectionBanner />
        <div ref={outerRowRef} className="flex flex-1 overflow-hidden">
          {/* Docked project tree: hidden when collapsed, force-shown in settings,
              or shown as a float (see below). Maximize hides only the chat pane. */}
          {(!sidebarCollapsed || settingsOpen) && !sidebarFloating && (
            <div
              data-testid="sidebar-docked"
              className="flex shrink-0 overflow-hidden border-r border-border/45 bg-page"
            >
              <Sidebar
                settingsOpen={settingsOpen}
                settingsSection={settingsSection}
                onSettingsSection={setSettingsSection}
                onOpenSettings={() => setSettingsOpen(true)}
                onCloseSettings={() => setSettingsOpen(false)}
              />
            </div>
          )}
          {sidebarFloating && !sidebarCollapsed && !settingsOpen && (
            <>
              <button
                type="button"
                aria-label="Close project tree"
                className="fixed inset-0 z-40 bg-black/20"
                onClick={() => useUiStore.getState().closeFloatingSidebar()}
              />
              <div
                data-testid="sidebar-floating"
                className="fixed bottom-1.5 left-1.5 top-1.5 z-50 flex w-72 overflow-hidden rounded-lg shadow-xl ring-1 ring-border/40"
              >
                <Sidebar
                  settingsOpen={false}
                  settingsSection={settingsSection}
                  onSettingsSection={setSettingsSection}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onCloseSettings={() => setSettingsOpen(false)}
                />
              </div>
            </>
          )}
          <div
            ref={contentRowRef}
            data-testid="content-row"
            className="flex min-w-0 flex-1 overflow-hidden"
          >
            {/* Chat / settings / landing: hidden when the right panel is maximized. */}
            {!rightPanelMaximized && (
            <main
              className="flex-1 overflow-hidden bg-background"
              style={{ minWidth: COMPOSER_MIN_WIDTH }}
            >
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
            )}
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
