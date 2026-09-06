import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  useRef,
  lazy,
  Suspense,
  type RefObject,
} from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChatView } from "@/features/conversation";
import { openSubagentDetail, openSubagentsRoster } from "@/features/subagents";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { useUpdateStore } from "@/stores/updateStore";
import { useToastStore } from "@/stores/toastStore";
import { friendlyUpdateError } from "@/lib/update-error-message";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { ShortcutHelpDialog } from "@/components/ShortcutHelpDialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useRecoveryIncidentStore } from "@/features/recovery/state/recoveryIncidentStore";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { COMPOSER_MIN_WIDTH, useDiffStore } from "@/stores/diffStore";
import {
  usePreviewDesignModeStore,
  usePreviewFocusStore,
} from "@/features/preview";
import { useUiStore } from "@/stores/uiStore";
import { initShortcuts } from "@/lib/shortcuts";
import { summonTab } from "@/lib/summon-tab";
import { executeCommand, registerCommand } from "@/lib/command-registry";
import { setContext } from "@/lib/context-tracker";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { useIdleReclamation } from "@/hooks/useIdleReclamation";
import { useComposerLayoutGuard } from "@/hooks/useComposerLayoutGuard";
import { showRightPanelAdaptive, toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastContainer } from "@/components/Toast";
import type { SettingsSection } from "@/components/settings/settings-nav";
import {
  BrowserAutomationHost,
  BrowserSurfaceHostRoot,
} from "@/features/preview";
import { TerminalPoolHost, TerminalPoolSlotProvider } from "@/features/terminal";
import { DesktopTitleBar } from "@/components/desktop/DesktopTitleBar";
import {
  useNavigationHistoryStore,
  type NavigationHistoryState,
  type NavigationLocation,
  type PullRequestHistoryTab,
} from "@/stores/navigationHistoryStore";
import {
  usePullRequestDetailStore,
  usePullRequestStore,
} from "@/features/pull-requests";

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

const LazyPullRequestSurface = lazy(async () => {
  const m = await import("@/features/pull-requests");
  return { default: m.PullRequestSurface };
});

const LazyNoticePrototype = import.meta.env.DEV
  ? lazy(async () => {
      const m = await import("@/features/conversation/messages/NoticePrototype");
      return { default: m.NoticePrototype };
    })
  : null;

type AppLayoutProps = {
  isDesktop: boolean;
  navigationHistory: NavigationHistoryState;
  isValidLocation: (location: NavigationLocation) => boolean;
  navigateHistory: (direction: "back" | "forward") => void;
  outerRowRef: RefObject<HTMLDivElement | null>;
  contentRowRef: RefObject<HTMLDivElement | null>;
  floatingBackdropRef: RefObject<HTMLButtonElement | null>;
  floatingSidebarRef: RefObject<HTMLDivElement | null>;
  sidebarFloating: boolean;
  dockedSidebarVisible: boolean;
  floatingSidebarRendered: boolean;
  floatingSidebarExiting: boolean;
  rightPanelMaximized: boolean;
  showNewThreadCanvas: boolean;
  showProjectlessCanvas: boolean;
  showPullRequests: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  pullRequestTab: PullRequestHistoryTab;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setPullRequestTab: (tab: PullRequestHistoryTab) => void;
  closeSettings: () => void;
};

type FloatingSidebarTransition = "hidden" | "visible" | "exiting";

function floatingSidebarTransitionReducer(
  _state: FloatingSidebarTransition,
  transition: FloatingSidebarTransition,
): FloatingSidebarTransition {
  return transition;
}

function blurFloatingSidebarFocus(
  backdropRef: RefObject<HTMLButtonElement | null>,
  sidebarRef: RefObject<HTMLDivElement | null>,
): void {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  if (!backdropRef.current?.contains(activeElement) && !sidebarRef.current?.contains(activeElement)) {
    return;
  }
  activeElement.blur();
}

function useFloatingSidebarTransition(
  open: boolean,
  backdropRef: RefObject<HTMLButtonElement | null>,
  sidebarRef: RefObject<HTMLDivElement | null>,
) {
  const [transition, dispatchTransition] = useReducer(
    floatingSidebarTransitionReducer,
    open ? "visible" : "hidden",
  );

  useEffect(() => {
    if (open) {
      if (transition !== "visible") dispatchTransition("visible");
      return;
    }
    if (transition === "hidden") return;
    if (transition === "exiting") {
      const exitTimer = window.setTimeout(() => dispatchTransition("hidden"), 200);
      return () => window.clearTimeout(exitTimer);
    }

    blurFloatingSidebarFocus(backdropRef, sidebarRef);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dispatchTransition("hidden");
      return;
    }
    dispatchTransition("exiting");
  }, [backdropRef, open, sidebarRef, transition]);

  return {
    rendered: transition !== "hidden",
    exiting: transition === "exiting",
  };
}

function DockedSidebar({
  visible,
  settingsOpen,
  settingsSection,
  setSettingsOpen,
  setSettingsSection,
  closeSettings,
}: {
  visible: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  closeSettings: () => void;
}) {
  return (
    <div
      data-testid="sidebar-docked"
      aria-hidden={!visible}
      inert={!visible}
      className={`grid shrink-0 overflow-hidden bg-page transition-[grid-template-columns] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        visible
          ? "grid-cols-[1fr] duration-250"
          : "pointer-events-none grid-cols-[0fr] duration-200"
      }`}
    >
      <div
        className={`min-w-0 overflow-hidden transition-[opacity,transform] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          visible
            ? "translate-x-0 border-r border-border/45 opacity-100 duration-250"
            : "-translate-x-2 opacity-0 duration-200"
        }`}
      >
        <Sidebar
          settingsOpen={settingsOpen}
          settingsSection={settingsSection}
          onSettingsSection={setSettingsSection}
          onOpenSettings={() => setSettingsOpen(true)}
          onCloseSettings={closeSettings}
        />
      </div>
    </div>
  );
}

function FloatingSidebar({
  backdropRef,
  sidebarRef,
  exiting,
  settingsSection,
  setSettingsOpen,
  setSettingsSection,
  closeSettings,
}: {
  backdropRef: RefObject<HTMLButtonElement | null>;
  sidebarRef: RefObject<HTMLDivElement | null>;
  exiting: boolean;
  settingsSection: SettingsSection;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  closeSettings: () => void;
}) {
  return (
    <>
      <button
        ref={backdropRef}
        type="button"
        aria-label="Close project tree"
        aria-hidden={exiting}
        inert={exiting}
        className={`app-viewport-fixed fixed z-40 bg-black/20 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none ${
          exiting ? "pointer-events-none animate-out fade-out-0" : "animate-in fade-in-0"
        }`}
        onClick={() => useUiStore.getState().closeFloatingSidebar()}
      />
      <div
        ref={sidebarRef}
        data-testid="sidebar-floating"
        aria-hidden={exiting}
        inert={exiting}
        className={`app-panel-top-inset fixed bottom-1.5 left-1.5 z-50 flex w-72 overflow-hidden rounded-lg bg-page shadow-xl ring-1 ring-border/40 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none ${
          exiting
            ? "pointer-events-none animate-out fade-out-0 slide-out-to-left-4 duration-200"
            : "animate-in fade-in-0 slide-in-from-left-4 duration-250"
        }`}
      >
        <Sidebar
          className="w-full max-w-none"
          settingsOpen={false}
          settingsSection={settingsSection}
          onSettingsSection={setSettingsSection}
          onOpenSettings={() => setSettingsOpen(true)}
          onCloseSettings={closeSettings}
        />
      </div>
    </>
  );
}

function PullRequestMainSurface({
  isDesktop,
  pullRequestTab,
  setPullRequestTab,
  isValidLocation,
  navigateHistory,
}: Pick<
  AppLayoutProps,
  "isDesktop" | "pullRequestTab" | "setPullRequestTab" | "isValidLocation" | "navigateHistory"
>) {
  const handleHistoryBack = () => {
    if (useNavigationHistoryStore.getState().canGoBack(isValidLocation)) {
      navigateHistory("back");
      return;
    }
    usePullRequestDetailStore.getState().close();
  };

  return (
    <Suspense fallback={null}>
      <LazyPullRequestSurface
        activeTab={isDesktop ? pullRequestTab : undefined}
        onActiveTabChange={isDesktop ? setPullRequestTab : undefined}
        onHistoryBack={isDesktop ? handleHistoryBack : undefined}
      />
    </Suspense>
  );
}

function AppPrimarySurface(props: Pick<
  AppLayoutProps,
  "settingsOpen" | "settingsSection" | "showPullRequests" | "isDesktop" | "pullRequestTab" | "setPullRequestTab" | "isValidLocation" | "navigateHistory"
>) {
  if (props.settingsOpen) {
    return (
      <Suspense fallback={null}>
        <LazySettingsView section={props.settingsSection} />
      </Suspense>
    );
  }
  if (props.showPullRequests) return <PullRequestMainSurface {...props} />;
  return <ChatView onSubagentSelect={openSubagentDetail} onOpenSubagents={openSubagentsRoster} />;
}

function AppMainSurface(props: Pick<
  AppLayoutProps,
  "rightPanelMaximized" | "showPullRequests" | "showNewThreadCanvas" | "settingsOpen" | "settingsSection" | "isDesktop" | "pullRequestTab" | "setPullRequestTab" | "isValidLocation" | "navigateHistory"
>) {
  if (props.rightPanelMaximized && !props.showPullRequests) return null;
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("noticePrototype") === "1" && LazyNoticePrototype) {
    return <Suspense fallback={null}><LazyNoticePrototype /></Suspense>;
  }
  const useFlexibleWidth = props.showNewThreadCanvas || props.settingsOpen || props.showPullRequests;
  return (
    <main
      className="flex-1 overflow-hidden bg-background"
      style={{ minWidth: useFlexibleWidth ? 0 : `min(100%, ${COMPOSER_MIN_WIDTH}px)` }}
    >
      <AppPrimarySurface {...props} />
    </main>
  );
}

function RightPanelSlot({
  settingsOpen,
  showProjectlessCanvas,
  showPullRequests,
}: Pick<AppLayoutProps, "settingsOpen" | "showProjectlessCanvas" | "showPullRequests">) {
  if (settingsOpen || showProjectlessCanvas || showPullRequests) return null;
  return (
    <Suspense fallback={null}>
      <LazyRightPanel />
    </Suspense>
  );
}

function AppLayout(props: AppLayoutProps) {
  return (
    <TerminalPoolSlotProvider>
      <TooltipProvider delay={400}>
        <div className="flex h-screen flex-col overflow-hidden bg-page text-foreground">
          {props.isDesktop ? (
            <DesktopTitleBar
              canGoBack={props.navigationHistory.canGoBack(props.isValidLocation)}
              canGoForward={props.navigationHistory.canGoForward(props.isValidLocation)}
              onBack={() => props.navigateHistory("back")}
              onForward={() => props.navigateHistory("forward")}
            />
          ) : null}
          <ConnectionBanner />
          <div ref={props.outerRowRef} className="flex flex-1 overflow-hidden">
            {!props.sidebarFloating && (
              <DockedSidebar
                visible={props.dockedSidebarVisible}
                settingsOpen={props.settingsOpen}
                settingsSection={props.settingsSection}
                setSettingsOpen={props.setSettingsOpen}
                setSettingsSection={props.setSettingsSection}
                closeSettings={props.closeSettings}
              />
            )}
            {props.floatingSidebarRendered && (
              <FloatingSidebar
                backdropRef={props.floatingBackdropRef}
                sidebarRef={props.floatingSidebarRef}
                exiting={props.floatingSidebarExiting}
                settingsSection={props.settingsSection}
                setSettingsOpen={props.setSettingsOpen}
                setSettingsSection={props.setSettingsSection}
                closeSettings={props.closeSettings}
              />
            )}
            <div ref={props.contentRowRef} data-testid="content-row" className="flex min-w-0 flex-1 overflow-hidden">
              <AppMainSurface {...props} />
              <RightPanelSlot {...props} />
            </div>
          </div>
        </div>
        <TerminalPoolHost />
        <BrowserSurfaceHostRoot />
        <BrowserAutomationHost />
        <Suspense fallback={null}>
          <LazyCommandPalette />
        </Suspense>
        <ShortcutHelpDialog />
        <ToastContainer />
      </TooltipProvider>
    </TerminalPoolSlotProvider>
  );
}

/** Root application component. Initializes WS transport and push listeners. */
export function App() {
  const isDesktop = Boolean(window.desktopBridge?.window);
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("model");
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarFloating = useUiStore((s) => s.sidebarFloating);
  const rightPanelMaximized = useUiStore((s) => s.rightPanelMaximized);
  const primarySurface = useUiStore((s) => s.primarySurface);
  const connectionStatus = useConnectionStore((s) => s.status);
  const setRecoveryIncident = useRecoveryIncidentStore((s) => s.setIncident);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activePullRequestKey = usePullRequestDetailStore((s) => s.activeKey);
  const navigationHistory = useNavigationHistoryStore();
  const [pullRequestTab, setPullRequestTab] =
    useState<PullRequestHistoryTab>("summary");
  const outerRowRef = useRef<HTMLDivElement>(null);
  const contentRowRef = useRef<HTMLDivElement>(null);
  const floatingBackdropRef = useRef<HTMLButtonElement>(null);
  const floatingSidebarRef = useRef<HTMLDivElement>(null);
  const showNewThreadCanvas = activeThreadId === null;
  const showProjectlessCanvas =
    showNewThreadCanvas && activeWorkspaceId === null;
  const showPullRequests = primarySurface === "pullRequests" && !settingsOpen;
  const dockedSidebarVisible =
    !sidebarCollapsed || (settingsOpen && !isDesktop);
  const floatingSidebarOpen =
    sidebarFloating && !sidebarCollapsed && !settingsOpen;
  const {
    rendered: floatingSidebarRendered,
    exiting: floatingSidebarExiting,
  } = useFloatingSidebarTransition(
    floatingSidebarOpen,
    floatingBackdropRef,
    floatingSidebarRef,
  );
  useIdleReclamation();

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    let cancelled = false;
    void getTransport().getRecoveryIncident().then((incident) => {
      if (!cancelled) setRecoveryIncident(incident);
    }).catch((error: unknown) => {
      console.error("Failed to load recovery incident", error);
    });
    return () => {
      cancelled = true;
    };
  }, [connectionStatus, setRecoveryIncident]);

  useComposerLayoutGuard(outerRowRef, contentRowRef, {
    settingsOpen,
    showLanding: showProjectlessCanvas,
    showPullRequests,
    activeWorkspaceId,
    activeThreadId,
  });

  // Settings uses a docked project tree; undock the float when entering settings.
  useEffect(() => {
    if (settingsOpen) {
      useUiStore.setState({ sidebarFloating: false, sidebarCollapsed: false });
    }
  }, [settingsOpen]);

  const isValidLocation = useCallback(
    (location: NavigationLocation): boolean => {
      const workspace = useWorkspaceStore.getState();
      if (
        location.workspaceId &&
        !workspace.workspaces.some((item) => item.id === location.workspaceId)
      ) {
        return false;
      }
      if (location.kind === "thread") {
        return (
          location.workspaceId !== workspace.activeWorkspaceId ||
          workspace.threads.some((thread) => thread.id === location.threadId)
        );
      }
      if (location.kind === "pullRequestDetail") {
        return Boolean(
          usePullRequestStore.getState().entities[location.identityKey],
        );
      }
      return true;
    },
    [],
  );

  const replayLocation = useCallback(
    async (location: NavigationLocation): Promise<boolean> => {
      const workspace = useWorkspaceStore.getState();
      if (location.workspaceId !== workspace.activeWorkspaceId) {
        workspace.setActiveWorkspace(location.workspaceId, undefined, false);
        if (location.workspaceId)
          await useWorkspaceStore.getState().loadThreads(location.workspaceId);
      }
      if (location.kind === "thread") {
        if (
          !useWorkspaceStore
            .getState()
            .threads.some((thread) => thread.id === location.threadId)
        )
          return false;
        setSettingsOpen(false);
        useUiStore.getState().setPrimarySurface("chat");
        useWorkspaceStore.getState().setActiveThread(location.threadId);
        return true;
      }
      if (location.kind === "newThread") {
        setSettingsOpen(false);
        useUiStore.getState().setPrimarySurface("chat");
        useWorkspaceStore.getState().beginNewThread(location.workspaceId);
        return true;
      }
      if (location.kind === "settings") {
        setSettingsSection(location.section);
        setSettingsOpen(true);
        return true;
      }
      setSettingsOpen(false);
      useUiStore.getState().setPrimarySurface("pullRequests");
      if (location.kind === "pullRequests") {
        usePullRequestDetailStore.getState().close();
        return true;
      }
      const summary =
        usePullRequestStore.getState().entities[location.identityKey];
      if (!summary) return false;
      setPullRequestTab(location.tab);
      usePullRequestDetailStore.getState().open(summary.identity);
      return true;
    },
    [],
  );

  const navigateHistory = useCallback(
    (direction: "back" | "forward") => {
      const history = useNavigationHistoryStore.getState();
      const location =
        direction === "back"
          ? history.back(isValidLocation)
          : history.forward(isValidLocation);
      if (!location) {
        history.clearReplayTarget();
        return;
      }
      void replayLocation(location).then((restored) => {
        if (!restored) navigateHistory(direction);
      });
    },
    [isValidLocation, replayLocation],
  );

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    useUiStore.getState().setPrimarySurface("chat");
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    let location: NavigationLocation;
    if (settingsOpen) {
      location = {
        kind: "settings",
        workspaceId: activeWorkspaceId,
        section: settingsSection,
      };
    } else if (primarySurface === "pullRequests") {
      location = activePullRequestKey
        ? {
            kind: "pullRequestDetail",
            workspaceId: activeWorkspaceId,
            identityKey: activePullRequestKey,
            tab: pullRequestTab,
          }
        : { kind: "pullRequests", workspaceId: activeWorkspaceId };
    } else if (activeThreadId && activeWorkspaceId) {
      location = {
        kind: "thread",
        workspaceId: activeWorkspaceId,
        threadId: activeThreadId,
      };
    } else {
      location = { kind: "newThread", workspaceId: activeWorkspaceId };
    }
    useNavigationHistoryStore.getState().record(location);
  }, [
    activePullRequestKey,
    activeThreadId,
    activeWorkspaceId,
    isDesktop,
    primarySurface,
    pullRequestTab,
    settingsOpen,
    settingsSection,
  ]);

  useEffect(() => {
    startPushListeners();
    useSettingsStore.getState().fetch();
    return () => stopPushListeners();
  }, []);

  // Hydrate app version + auto-updater status from the Electron preload bridge.
  useEffect(() => {
    const bridge = window.desktopBridge?.app;
    if (!bridge) return;

    void bridge
      .getVersion()
      .then((v) => useUpdateStore.getState().setVersion(v));
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
      const section =
        (e as CustomEvent<{ section: SettingsSection }>).detail?.section ??
        "model";
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

  // Keep the legacy context key scoped to the projectless canvas so the existing
  // add-project shortcut remains available without bringing back the old landing.
  useEffect(() => {
    setContext("showLanding", showProjectlessCanvas && !settingsOpen);
  }, [showProjectlessCanvas, settingsOpen]);

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
      registerCommand({
        id: "navigation.back",
        title: "Back",
        category: "Navigation",
        handler: () => navigateHistory("back"),
      }),
      registerCommand({
        id: "navigation.forward",
        title: "Forward",
        category: "Navigation",
        handler: () => navigateHistory("forward"),
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
            const workspace = useWorkspaceStore.getState();
            const threadId = workspace.activeThreadId;
            if (
              threadId &&
              usePreviewDesignModeStore.getState().isActive(threadId)
            ) {
              const event = new CustomEvent("mcode:preview-design-escape", {
                cancelable: true,
                detail: { threadId },
              });
              const handled = !window.dispatchEvent(event);
              if (!handled) {
                usePreviewDesignModeStore.getState().setActive(threadId, false);
                void window.desktopBridge?.preview?.cancelCapture?.();
              }
              return;
            }
          }
        },
      }),
      registerCommand({
        id: "thread.new",
        title: "New Thread",
        category: "Thread",
        handler: () => {
          useWorkspaceStore.getState().beginNewThread();
        },
      }),
      registerCommand({
        id: "thread.search",
        title: "Search Threads",
        category: "Thread",
        handler: () => {
          useCommandPaletteStore.getState().open({ intent: "threadSearch" });
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
        id: "pullRequests.open",
        title: "Open Pull requests",
        category: "Navigation",
        handler: () => useUiStore.getState().setPrimarySurface("pullRequests"),
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
          const { activeWorkspaceId, activeThreadId } =
            useWorkspaceStore.getState();
          if (!activeWorkspaceId) return;
          toggleRightPanelAdaptive(activeWorkspaceId, activeThreadId);
        },
      }),
      registerCommand({
        id: "projectEnvironment.open",
        title: "Open Project Settings",
        category: "Project",
        handler: () => {
          const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
          if (!activeWorkspaceId) return;
          showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
          useDiffStore.getState().setRightPanelTab(activeWorkspaceId, activeThreadId, "environment");
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
        title: "Toggle Plan Panel",
        category: "View",
        // Plan is thread-only; summonTab no-ops when there is no thread.
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
  }, [navigateHistory]);

  useEffect(() => {
    const desktopWindow = window.desktopBridge?.window;
    if (!desktopWindow?.onCommand || !desktopWindow.offCommand) return;
    const listener = desktopWindow.onCommand((command) => {
      if (command === "settings.keyboard" || command === "settings.about") {
        window.dispatchEvent(
          new CustomEvent("mcode:open-settings", {
            detail: {
              section: command === "settings.keyboard" ? "keyboard" : "about",
            },
          }),
        );
        return;
      }
      executeCommand(command);
    });
    return () => desktopWindow.offCommand?.(listener);
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
    <AppLayout
      isDesktop={isDesktop}
      navigationHistory={navigationHistory}
      isValidLocation={isValidLocation}
      navigateHistory={navigateHistory}
      outerRowRef={outerRowRef}
      contentRowRef={contentRowRef}
      floatingBackdropRef={floatingBackdropRef}
      floatingSidebarRef={floatingSidebarRef}
      sidebarFloating={sidebarFloating}
      dockedSidebarVisible={dockedSidebarVisible}
      floatingSidebarRendered={floatingSidebarRendered}
      floatingSidebarExiting={floatingSidebarExiting}
      rightPanelMaximized={rightPanelMaximized}
      showNewThreadCanvas={showNewThreadCanvas}
      showProjectlessCanvas={showProjectlessCanvas}
      showPullRequests={showPullRequests}
      settingsOpen={settingsOpen}
      settingsSection={settingsSection}
      pullRequestTab={pullRequestTab}
      setSettingsOpen={setSettingsOpen}
      setSettingsSection={setSettingsSection}
      setPullRequestTab={setPullRequestTab}
      closeSettings={closeSettings}
    />
  );
}
