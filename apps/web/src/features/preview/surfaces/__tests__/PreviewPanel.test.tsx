/**
 * Composition tests for PreviewPanel.
 *
 * Covers the two rendering paths:
 * 1. Unavailable state - when desktopBridge.preview is absent.
 * 2. Full panel state - when desktopBridge.preview is present (hooks mocked).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  getDefaultSettings,
  type BrowserAutomationHostDispatch,
} from "@mcode/contracts";

const {
  mockUsePreviewBridge,
  mockUsePreviewTabs,
  mockOnAddElementAnnotation,
  mockCaptureAnnotationSnapshot,
  mockCaptureSuccess,
  mockGetProviderCatalog,
} = vi.hoisted(() => ({
  mockUsePreviewBridge: vi.fn(),
  mockUsePreviewTabs: vi.fn<() => {
    tabSet: unknown;
    newTab: () => unknown;
    activateTab: () => unknown;
    closeTab: () => unknown;
  }>(() => ({
    tabSet: null,
    newTab: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
  })),
  mockOnAddElementAnnotation: vi.fn(),
  mockCaptureAnnotationSnapshot: vi.fn(),
  mockCaptureSuccess: {
    current: undefined as ((kind: "viewport" | "region" | "element" | "context") => void) | undefined,
  },
  mockGetProviderCatalog: vi.fn().mockResolvedValue({
    providerId: "claude",
    context: { scope: "user" },
    freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
    diagnostics: [],
    entries: [
      { kind: "skill", identity: { providerId: "claude", kind: "skill", nativeId: "commit" }, name: "commit", description: "Create a git commit", source: "user" },
      { kind: "skill", identity: { providerId: "claude", kind: "skill", nativeId: "review-pr" }, name: "review-pr", description: "Review a pull request", source: "user" },
    ],
    selectableAgents: [],
  }),
}));

// Mock hooks before importing the component under test.
vi.mock("../../navigation/usePreviewSurfaceBridge", () => ({
  usePreviewSurfaceBridge: mockUsePreviewBridge,
  formatNavError: (code: string) => code,
}));

// Transport mock keeps provider catalog eager-prefetch from hitting real IPC in
// tests. The mock is shared across all describe blocks; individual tests that
// need specific catalogs override mockGetProviderCatalog directly.
vi.mock("@/transport", () => ({
  getTransport: () => ({ getProviderCatalog: mockGetProviderCatalog }),
}));

// The panel only consumes usePreviewTabs for the header's "New page" action and
// the store subscription; page switching/closing lives in the activity rail.
vi.mock("../../tabs/usePreviewTabs", () => ({
  usePreviewTabs: mockUsePreviewTabs,
}));

vi.mock("../../capture/usePreviewCapture", () => ({
  usePreviewCapture: ({ onSuccess }: {
    readonly onSuccess?: (kind: "viewport" | "region" | "element" | "context") => void;
  }) => {
    mockCaptureSuccess.current = onSuccess;
    return {
      captureBusy: false,
      regionBusy: false,
      elementPickBusy: false,
      contextBusy: false,
      anyCaptureActive: false,
      onAddPictureReference: vi.fn(),
      onAddRegionPictureReference: vi.fn(),
      onAddElementPickPictureReference: vi.fn(),
      onAddPageContextOnly: vi.fn(),
      onAddElementAnnotation: mockOnAddElementAnnotation,
      captureAnnotationSnapshot: mockCaptureAnnotationSnapshot,
    };
  },
}));

import {
  PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
  PreviewPanel,
} from "../PreviewPanel";
import { executeWebBrowserDispatch } from "../../automation/browserAutomationWebExecutor";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  normalizePreviewPageIdentity,
  usePreviewAnnotationStore,
} from "../../state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "../../state/previewDesignModeStore";
import { useProviderCatalogStore } from "@/stores/providerCatalogStore";
import { previewTabsScopeKey, usePreviewTabsStore } from "../../state/previewTabsStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  browserAutomationTargetKey,
  useBrowserAutomationStore,
} from "../../automation/browserAutomationStore";
import { ViewportCoordinator } from "../../automation/services/viewportCoordinator";
import { browserSurfaceHost } from "../BrowserSurfaceHostRoot";

function mockBridgeState(overrides: Record<string, unknown> = {}) {
  const state = {
    inputUrl: "",
    setInputUrl: vi.fn(),
    navError: null,
    canBack: false,
    canFwd: false,
    previewLoading: false,
    pageTitle: null,
    faviconUrl: null,
    pageStatus: { url: null, title: null, favicon: null, phase: "loaded" },
    storedUrl: "",
    pushSync: vi.fn(),
    refreshNav: vi.fn(),
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onReload: vi.fn(),
    onOpenExternal: vi.fn(),
    resolveNavigation: vi.fn().mockResolvedValue({ ok: true, url: "https://example.com" }),
    onNavigate: vi.fn(),
    onRetry: vi.fn(),
    onForceReload: vi.fn(),
    onClearCookies: vi.fn(),
    onClearCache: vi.fn(),
    onGetZoom: vi.fn().mockResolvedValue(1),
    onSetZoom: vi.fn().mockResolvedValue(1),
  };
  return { ...state, ...overrides };
}

function installMockWebviewMethods(options: {
  readonly loadURL?: (url: string) => Promise<void>;
  readonly getURL?: () => string;
  readonly getWebContentsId?: () => number;
  readonly reload?: () => void;
}): () => void {
  const proto = HTMLElement.prototype as HTMLElement & {
    loadURL?: (url: string) => Promise<void>;
    getURL?: () => string;
    getWebContentsId?: () => number;
    reload?: () => void;
    canGoBack?: () => boolean;
    canGoForward?: () => boolean;
  };
  const loadURLDescriptor = Object.getOwnPropertyDescriptor(proto, "loadURL");
  const getURLDescriptor = Object.getOwnPropertyDescriptor(proto, "getURL");
  const getWebContentsIdDescriptor = Object.getOwnPropertyDescriptor(
    proto,
    "getWebContentsId",
  );
  const reloadDescriptor = Object.getOwnPropertyDescriptor(proto, "reload");
  const canGoBackDescriptor = Object.getOwnPropertyDescriptor(proto, "canGoBack");
  const canGoForwardDescriptor = Object.getOwnPropertyDescriptor(proto, "canGoForward");
  if (options.loadURL) {
    Object.defineProperty(proto, "loadURL", {
      configurable: true,
      value: options.loadURL,
    });
  }
  if (options.getURL) {
    Object.defineProperty(proto, "getURL", {
      configurable: true,
      value: options.getURL,
    });
  }
  Object.defineProperty(proto, "getWebContentsId", {
    configurable: true,
    value: options.getWebContentsId ?? (() => 1),
  });
  if (options.reload) {
    Object.defineProperty(proto, "reload", {
      configurable: true,
      value: options.reload,
    });
  }
  Object.defineProperty(proto, "canGoBack", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(proto, "canGoForward", {
    configurable: true,
    value: () => false,
  });

  return () => {
    if (loadURLDescriptor) {
      Object.defineProperty(proto, "loadURL", loadURLDescriptor);
    } else {
      delete proto.loadURL;
    }
    if (getURLDescriptor) {
      Object.defineProperty(proto, "getURL", getURLDescriptor);
    } else {
      delete proto.getURL;
    }
    if (getWebContentsIdDescriptor) {
      Object.defineProperty(proto, "getWebContentsId", getWebContentsIdDescriptor);
    } else {
      delete proto.getWebContentsId;
    }
    if (reloadDescriptor) {
      Object.defineProperty(proto, "reload", reloadDescriptor);
    } else {
      delete proto.reload;
    }
    if (canGoBackDescriptor) {
      Object.defineProperty(proto, "canGoBack", canGoBackDescriptor);
    } else {
      delete proto.canGoBack;
    }
    if (canGoForwardDescriptor) {
      Object.defineProperty(proto, "canGoForward", canGoForwardDescriptor);
    } else {
      delete proto.canGoForward;
    }
  };
}

function installDraftAnnotation(overrides: Record<string, unknown> = {}) {
  usePreviewDesignModeStore.getState().setActive("thread-1", true);
  usePreviewAnnotationStore.getState().setDraft("thread-1", {
    threadId: "thread-1",
    pageIdentity: "",
    bounds: { x: 20, y: 24, width: 120, height: 32 },
    selectorHint: "button",
    label: "button",
    pageContext: {
      schemaVersion: 2,
      pageUrl: "https://example.com",
      pageTitle: "Example",
      capturedAt: "2026-07-01T00:00:00.000Z",
      captureKind: "element",
      bounds: { x: 20, y: 24, width: 120, height: 32 },
      layoutViewport: { width: 800, height: 600 },
    },
    note: "",
    ...overrides,
  });
}

function installSavedAnnotation(
  overrides: Record<string, unknown> = {},
) {
  const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
  usePreviewAnnotationStore.getState().saveAnnotation("thread-1", {
    threadId: "thread-1",
    pageIdentity: normalizePreviewPageIdentity(pageUrl),
    bounds: { x: 20, y: 24, width: 120, height: 32 },
    selectorHint: "button",
    label: "button",
    pageContext: {
      schemaVersion: 2,
      pageUrl,
      pageTitle: "Example",
      capturedAt: "2026-07-01T00:00:00.000Z",
      captureKind: "element",
      bounds: { x: 20, y: 24, width: 120, height: 32 },
      layoutViewport: { width: 800, height: 600 },
    },
    note: "Move this button",
    snapshot: {
      id: "capture-saved",
      name: "Preview annotation",
      mimeType: "image/png",
      sizeBytes: 12,
      sourcePath: "preview/capture-saved.png",
      capture: {
        schemaVersion: 2,
        pageUrl,
        pageTitle: "Example",
        capturedAt: "2026-07-01T00:00:00.000Z",
        captureKind: "element",
        bounds: { x: 20, y: 24, width: 120, height: 32 },
        layoutViewport: { width: 800, height: 600 },
      },
    },
    ...overrides,
  });
}

describe("PreviewPanel: unavailable state", () => {
  beforeEach(() => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
    // Ensure no desktopBridge is present.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
  });

  afterEach(() => {
    browserSurfaceHost.disposeAll();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    mockUsePreviewBridge.mockClear();
    vi.unstubAllEnvs();
    useDiffStore.setState({ previewUrlByThread: {} });
  });

  it("renders the unavailable state when desktopBridge is absent", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(
      screen.getByTestId("preview-panel-unavailable"),
    ).toBeInTheDocument();
  });

  it("does not render the full panel when desktopBridge is absent", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
  });

  it("renders the enabled same-origin web preview without an Electron bridge", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({ previewUrlByThread: { "thread-1": window.location.origin + "/fixture" } });
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByTestId("web-runtime-preview-iframe")).toHaveAttribute(
      "src",
      window.location.origin + "/fixture",
    );
    expect(screen.queryByTestId("web-runtime-cross-origin")).not.toBeInTheDocument();
  });

  it("publishes the web preview target identity used by the executor", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    useDiffStore.setState({ previewUrlByThread: { "thread-1": window.location.origin + "/fixture" } });
    render(<PreviewPanel threadId="thread-1" workspaceId="workspace-1" />);
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    expect(iframe).toHaveAttribute("data-thread-id", "thread-1");
    expect(iframe).toHaveAttribute("data-tab-id", "web-preview");
    expect(useBrowserAutomationStore.getState().liveTargets.get(
      JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
    )).toMatchObject({ workspaceId: "workspace-1", threadId: "thread-1", tabId: "web-preview" });
    const initialRevision = useBrowserAutomationStore.getState().liveTargets.get(
      JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
    )!.revision;
    fireEvent.load(iframe);
    expect(useBrowserAutomationStore.getState().liveTargets.get(
      JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
    )!.revision).toBe(initialRevision + 1);
    const page = document.implementation.createHTMLDocument("Fixture");
    page.body.innerHTML = "<main>Visible fixture</main>";
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: page });
    const result = await executeWebBrowserDispatch({
      scope: {
        workspaceId: "workspace-1",
        threadId: "thread-1",
        providerSessionId: "session-1",
        providerInstanceId: "instance-1",
      },
      connection: {
        desktopInstanceId: "web",
        windowId: 1,
        connectionGeneration: 1,
        targetGeneration: 1,
      },
      request: {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        workspaceId: "workspace-1",
        threadId: "thread-1",
        providerSessionId: "session-1",
        providerInstanceId: "instance-1",
        requestId: "request-preview",
        sequence: 1,
        deadline: Date.now() + 1_000,
        expectedControlEpoch: 0,
        operation: "snapshot",
        args: { includeScreenshot: false },
      },
      target: {
        desktopInstanceId: "web",
        windowId: 1,
        connectionGeneration: 1,
        threadId: "thread-1",
        tabId: "web-preview",
        targetGeneration: 1,
        active: true,
        focused: true,
        lastUsedAt: Date.now(),
      },
    } satisfies BrowserAutomationHostDispatch, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { operation: "snapshot" } });
    rect.mockRestore();
  });

  it("switches thread presentation without replacing the prior warm iframe", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({
      previewUrlByThread: {
        "thread-1": window.location.origin + "/first",
        "thread-2": window.location.origin + "/second",
      },
    });
    const view = render(<PreviewPanel threadId="thread-1" />);
    const firstIframe = screen.getByTestId("web-runtime-preview-iframe");
    view.rerender(<PreviewPanel threadId="thread-2" />);
    expect(screen.getByLabelText("Preview URL")).toHaveValue(window.location.origin + "/second");
    const secondIframe = screen.getAllByTestId("web-runtime-preview-iframe").find(
      (iframe) => iframe.getAttribute("data-thread-id") === "thread-2",
    );
    expect(secondIframe).toHaveAttribute(
      "src",
      window.location.origin + "/second",
    );
    expect(firstIframe).toBeInTheDocument();
    expect(firstIframe).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps a cross-origin page visible while identifying DOM automation as unsupported", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({ previewUrlByThread: { "thread-1": "https://example.com/fixture" } });
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByTestId("web-runtime-preview-iframe")).toBeInTheDocument();
    expect(screen.getByTestId("web-runtime-cross-origin")).toHaveTextContent(
      "automation and DOM access are unsupported",
    );
  });

  it("marks a same-origin requested page unsupported after cross-origin iframe navigation", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({ previewUrlByThread: { "thread-1": window.location.origin + "/fixture" } });
    render(<PreviewPanel threadId="thread-1" />);
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { location: { origin: "https://example.com" } },
    });
    fireEvent.load(iframe);
    await waitFor(() => {
      expect(screen.getByTestId("web-runtime-cross-origin")).toHaveTextContent(
        "automation and DOM access are unsupported",
      );
    });
  });

  it("explains that web preview automation is disabled by default", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "0");
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByTestId("preview-panel-unavailable")).toHaveTextContent(
      "Web preview automation is disabled",
    );
    expect(screen.queryByTestId("web-runtime-preview-iframe")).not.toBeInTheDocument();
  });

  it("renders the deterministic same-origin fixture when web automation is enabled", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.queryByTestId("preview-panel-unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("web-runtime-preview-iframe")).toHaveAttribute(
      "src",
      `${window.location.origin}/browser-automation-fixture.html`,
    );
  });

  it("hides the hosted iframe when navigation becomes unavailable", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="thread-1" />);
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    const input = screen.getByLabelText("Preview URL");

    fireEvent.change(input, { target: { value: "ftp://example.com" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(screen.getByTestId("web-runtime-unavailable")).toBeInTheDocument();
    await waitFor(() => {
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute("aria-hidden", "true");
      expect(iframe).toHaveStyle({ visibility: "hidden" });
    });
  });

  it("hides and restores a warm web runtime panel from explicit presentation visibility", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    const view = render(
      <PreviewPanel threadId="thread-1" workspaceId="workspace-1" presentationActive />,
    );
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    expect(iframe).toHaveStyle({ visibility: "visible", pointerEvents: "auto" });
    expect(iframe).toHaveAttribute("aria-hidden", "false");

    view.rerender(
      <PreviewPanel threadId="thread-1" workspaceId="workspace-1" presentationActive={false} />,
    );
    await waitFor(() => {
      expect(iframe).toHaveStyle({ visibility: "hidden", pointerEvents: "none" });
      expect(iframe).toHaveAttribute("aria-hidden", "true");
    });

    view.rerender(
      <PreviewPanel threadId="thread-1" workspaceId="workspace-1" presentationActive />,
    );
    await waitFor(() => {
      expect(iframe).toHaveStyle({ visibility: "visible", pointerEvents: "auto" });
      expect(iframe).toHaveAttribute("aria-hidden", "false");
    });
    rect.mockRestore();
  });

  it("keeps the responsive toolbar available through the web Browser overflow menu", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const user = userEvent.setup();
    render(<PreviewPanel threadId="thread-1" workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().viewportCoordinators.size).toBeGreaterThan(0);
    });
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    const menu = await screen.findByTestId("browser-overflow-menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Show device toolbar" }));

    const toolbar = await screen.findByTestId("browser-viewport-toolbar");
    expect(toolbar).toBeInTheDocument();
    await user.click(within(toolbar).getByRole("button", { name: "Viewport preset" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Responsive" }));
    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
        ),
      ).toMatchObject({ mode: "responsive" });
    });
    expect(screen.getByTestId("web-runtime-preview-iframe")).toBe(iframe);

    await user.click(within(toolbar).getByRole("button", { name: "Close viewport toolbar" }));
    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
        ),
      ).toMatchObject({ mode: "regular" });
    });
    expect(screen.queryByTestId("browser-viewport-toolbar")).not.toBeInTheDocument();
    expect(screen.getByTestId("web-runtime-preview-iframe")).toBe(iframe);
  });

  it("opens the toolbar in Fit presentation after a previous fixed zoom", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const user = userEvent.setup();
    render(<PreviewPanel threadId="thread-1" workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().viewportCoordinators.size).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    await user.click(within(await screen.findByTestId("browser-overflow-menu")).getByRole(
      "menuitem",
      { name: "Show device toolbar" },
    ));
    let toolbar = await screen.findByTestId("browser-viewport-toolbar");
    await user.click(within(toolbar).getByRole("button", { name: "Viewport scale and presentation" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "150%" }));
    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
        ),
      ).toMatchObject({ presentation: "150%" });
    });

    await user.click(within(toolbar).getByRole("button", { name: "Close viewport toolbar" }));
    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    await user.click(within(await screen.findByTestId("browser-overflow-menu")).getByRole(
      "menuitem",
      { name: "Show device toolbar" },
    ));
    toolbar = await screen.findByTestId("browser-viewport-toolbar");

    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
        ),
      ).toMatchObject({ mode: "responsive", presentation: "fit" });
    });
    expect(within(toolbar).getByRole("button", { name: "Viewport preset" })).toHaveTextContent("Responsive");
  });

  it("shows the responsive toolbar when the agent resizes the viewport", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="thread-1" workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().viewportCoordinators.size).toBeGreaterThan(0);
    });
    const coordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(
      JSON.stringify(["workspace-1", "thread-1", "web-preview"]),
    );
    expect(coordinator).toBeDefined();
    await coordinator!.requestAgentResize({ width: 393, height: 852 });

    expect(await screen.findByTestId("browser-viewport-toolbar")).toBeInTheDocument();
  });

  it("shows the toolbar from live agent state before the stored viewport projection catches up", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="thread-1" workspaceId="workspace-1" />);

    const targetKey = JSON.stringify(["workspace-1", "thread-1", "web-preview"]);
    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().liveTargets.has(targetKey)).toBe(true);
    });
    const targetGeneration = useBrowserAutomationStore.getState().liveTargets.get(targetKey)!.revision;
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      initial: { width: 1280, height: 800 },
      targetGeneration,
    });
    act(() => {
      useBrowserAutomationStore.getState().setViewportCoordinator(
        "workspace-1",
        "thread-1",
        "web-preview",
        coordinator,
      );
    });

    await act(async () => {
      await coordinator.requestAgentResize({ width: 393, height: 852 });
    });

    expect(screen.getByRole("separator", { name: "Resize viewport from top" })).toBeInTheDocument();
    expect(screen.getByTestId("browser-viewport-toolbar")).toBeInTheDocument();
  });
});

describe("PreviewPanel: full panel state", () => {
  beforeEach(() => {
    // Some panel descendants observe layout via ResizeObserver; jsdom lacks it.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // SlashCommandPopup calls scrollIntoView on focused list items; jsdom
    // doesn't implement it, so we stub the prototype once per test rather than
    // per-element. The stub is a no-op; the scroll behaviour is visual only
    // and is covered by e2e tests.
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = {
      preview: {
        sync: vi.fn().mockResolvedValue(undefined),
        navigate: vi.fn().mockResolvedValue({ ok: true }),
        goBack: vi.fn().mockResolvedValue(undefined),
        goForward: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        openExternal: vi.fn().mockResolvedValue(undefined),
        getNavigationState: vi
          .fn()
          .mockResolvedValue({ canGoBack: false, canGoForward: false }),
        onPageStatus: vi.fn().mockReturnValue(() => {}),
        cancelCapture: vi.fn().mockResolvedValue(undefined),
        surface: {
          prepare: vi.fn().mockResolvedValue({ ok: true }),
          adopt: vi.fn().mockResolvedValue({ ok: true }),
          release: vi.fn().mockResolvedValue({ ok: true }),
          navigate: vi.fn().mockResolvedValue({ ok: true }),
        },
        design: {
          setAnnotationGuard: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    };
    mockOnAddElementAnnotation.mockResolvedValue({ ok: true });
    mockCaptureSuccess.current = undefined;
    mockCaptureAnnotationSnapshot.mockResolvedValue({
      id: "capture-1",
      name: "Preview annotation 1",
      mimeType: "image/png",
      sizeBytes: 12,
      sourcePath: "preview/capture-1.png",
      capture: {
        schemaVersion: 2,
        pageUrl: "https://example.com",
        pageTitle: "Example",
        capturedAt: "2026-07-01T00:00:00.000Z",
        captureKind: "element",
        bounds: { x: 20, y: 24, width: 120, height: 32 },
        layoutViewport: { width: 800, height: 600 },
      },
    });
    useSettingsStore.getState()._applyPush(getDefaultSettings());
    usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
    usePreviewDesignModeStore.setState({ modes: {} });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {} });
    useDiffStore.setState({ previewUrlByThread: {} });
    useBrowserAutomationStore.setState({ controllers: new Map(), pendingAgentOpens: new Map() });
    useProviderCatalogStore.getState().reset();
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
    mockUsePreviewTabs.mockReturnValue({
      tabSet: null,
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
  });

  afterEach(() => {
    browserSurfaceHost.disposeAll();
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    useSettingsStore.getState()._applyPush(getDefaultSettings());
    usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
    usePreviewDesignModeStore.setState({ modes: {} });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {} });
    useBrowserAutomationStore.setState({ controllers: new Map(), pendingAgentOpens: new Map() });
    useProviderCatalogStore.getState().reset();
    mockUsePreviewBridge.mockClear();
    mockUsePreviewTabs.mockClear();
    mockOnAddElementAnnotation.mockClear();
    mockCaptureAnnotationSnapshot.mockClear();
  });

  it("renders the full panel when desktopBridge is present", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
  });

  it("shows the capture confirmation after a successful viewport capture", () => {
    render(<PreviewPanel threadId="thread-1" />);

    act(() => {
      mockCaptureSuccess.current?.("viewport");
    });

    const confirmation = screen.getByTestId("preview-capture-confirmation");
    expect(within(confirmation).getByText("attached")).toBeInTheDocument();
    expect(within(confirmation).getByText("screenshot")).toBeInTheDocument();
  });

  it("uses an amber shadow and edge wash while the agent controls Browser", () => {
    useBrowserAutomationStore.setState({
      controllers: new Map([
        [
          browserAutomationTargetKey(
            "thread-1",
            "thread-1",
            PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
          ),
          {
            tabId: PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
            controller: "agent",
            controlEpoch: 1,
          },
        ],
      ]),
    });

    render(<PreviewPanel threadId="thread-1" coveredLeft={112} />);

    const overlay = screen.getByTestId("browser-automation-overlay");
    expect(overlay.parentElement).toBe(screen.getByTestId("preview-surface"));
    expect(overlay).toHaveStyle({ clipPath: "inset(0 0 0 112px)" });
    expect(overlay).not.toHaveClass("border");
    expect(overlay).not.toHaveClass("border-2");
    expect(overlay).not.toHaveClass("border-primary");
    expect(overlay.style.backgroundImage).toContain("transparent 32px");
    expect(overlay.style.boxShadow).not.toContain("inset 0 0 0 1px");
    expect(overlay.style.boxShadow).toContain("inset 0 0 40px");
    expect(overlay.style.boxShadow).toContain("0 0 24px");
    expect(overlay.style.boxShadow).toContain("var(--primary)");
  });

  it("shows the agent frame and cursor while the active page is still opening", () => {
    useBrowserAutomationStore.setState({
      pendingAgentOpens: new Map([
        [
          "pending-open",
          {
            workspaceId: "workspace-1",
            threadId: "thread-1",
            tabId: PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
            url: "https://example.com",
            startedAt: 1,
          },
        ],
      ]),
    });

    render(<PreviewPanel threadId="thread-1" workspaceId="workspace-1" />);

    expect(screen.getByTestId("browser-automation-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("browser-automation-pointer")).toBeInTheDocument();
  });

  it("does not render the unavailable state when desktopBridge is present", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(
      screen.queryByTestId("preview-panel-unavailable"),
    ).not.toBeInTheDocument();
  });

  it("renders the omnibox URL input inside the full panel", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByLabelText("Preview URL")).toBeInTheDocument();
  });

  it("renders the navigation buttons inside the full panel", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    expect(screen.getByLabelText("Forward")).toBeInTheDocument();
  });

  it("shows the localhost-ports empty state when no page is loaded", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByTestId("browser-local-ports")).toBeInTheDocument();
  });

  it("accepts an optional workspaceId prop without error", () => {
    expect(() =>
      render(
        <PreviewPanel threadId="thread-1" workspaceId="ws-abc" />,
      ),
    ).not.toThrow();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
  });

  it("no longer renders a horizontal tab strip (the rail is the page switcher)", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.queryByTestId("preview-tab-bar")).not.toBeInTheDocument();
  });

  it("uses the webview preview path by default", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.queryByTestId("preview-webview-surface")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-local-ports")).toBeInTheDocument();
    expect(screen.getByTestId("preview-surface")).toHaveClass(
      "z-0",
      "overflow-hidden",
      "rounded-tl-md",
    );
    expect(mockUsePreviewBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
    );
  });

  it("keeps the webview path flush while preserving the empty state", () => {
    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.queryByTestId("preview-webview-surface")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preview-webview")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-local-ports")).toBeInTheDocument();
    expect(screen.getByTestId("preview-surface")).toHaveClass(
      "z-0",
      "overflow-hidden",
      "rounded-tl-md",
    );
    expect(screen.getByTestId("preview-surface")).not.toHaveClass(
      "mx-2",
      "mb-2",
      "mt-1",
      "rounded-md",
      "border",
      "bg-muted/10",
    );
    expect(screen.getByTestId("browser-header").parentElement).toHaveClass(
      "relative",
      "z-20",
    );
    expect(mockUsePreviewBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
    );
  });

  it("clips the Browser chrome around the expanded activity rail", () => {
    render(<PreviewPanel threadId="thread-1" coveredLeft={112} />);

    expect(screen.getByTestId("browser-header").parentElement).toHaveStyle({
      clipPath: "inset(0 0 0 112px)",
    });
  });

  it("mounts a blank Electron surface for a new page", async () => {
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "thread-1",
        activeTabId: "blank-tab",
        tabs: [
          {
            id: "blank-tab",
            threadId: "thread-1",
            title: "New page",
            url: null,
            faviconUrl: null,
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 640, 480),
    );
    try {
      render(<PreviewPanel threadId="thread-1" />);

      expect(screen.getByTestId("preview-webview")).toHaveAttribute(
        "data-tab-id",
        "blank-tab",
      );
      expect(
        screen.getByTestId("electron-browser-surface-webview").getAttribute("src"),
      ).toMatch(/^about:blank/);
      expect(screen.getByTestId("browser-local-ports")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("electron-browser-surface-webview")).toHaveStyle({
        visibility: "hidden",
        pointerEvents: "none",
      }));
    } finally {
      rect.mockRestore();
    }
  });

  it("renders the active URL in a live webview when the effective engine is webview", () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );

    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 640, 480),
    );
    try {
      render(<PreviewPanel threadId="thread-1" />);

      const webview = screen.getByTestId("preview-webview");
      expect(webview).toHaveAttribute("data-tab-id", PREVIEW_WEBVIEW_FALLBACK_TAB_ID);
      expect(webview).toHaveAttribute("src", "https://example.com");
      expect(webview).toHaveClass("absolute", "inset-0", "z-0", "h-full", "w-full");
      expect(screen.getByTestId("preview-panel")).toHaveClass("pointer-events-none");
      expect(screen.getByTestId("preview-surface")).toHaveClass("pointer-events-none");
      expect(screen.queryByTestId("browser-local-ports")).not.toBeInTheDocument();
      expect(screen.getByTestId("electron-browser-surface-webview")).toHaveStyle({
        visibility: "visible",
        pointerEvents: "auto",
      });
      expect(mockUsePreviewBridge).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: "thread-1" }),
      );
    } finally {
      rect.mockRestore();
    }
  });

  it("keeps an about:blank live tab stable while the persisted URL is empty", async () => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ storedUrl: "" }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "thread-1",
        activeTabId: "blank-tab",
        tabs: [{
          id: "blank-tab",
          threadId: "thread-1",
          title: null,
          url: "about:blank",
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "about:blank",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<PreviewPanel threadId="thread-1" />);
      const firstWebview = await screen.findByTestId("preview-webview");
      expect(firstWebview).toHaveAttribute("data-tab-id", "blank-tab");
      fireEvent(firstWebview, new Event("did-stop-loading"));
      view.rerender(<PreviewPanel threadId="thread-1" />);
      await waitFor(() => expect(screen.getByTestId("preview-webview")).toBe(firstWebview));
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
        "Maximum update depth exceeded",
      );
      view.unmount();
    } finally {
      consoleError.mockRestore();
      restoreWebviewMethods();
    }
  });

  it("preserves a page for a title-only event and clears it on authoritative blank navigation", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );
    useDiffStore.setState({
      previewUrlByThread: { "thread-1": "https://example.com" },
    });
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "about:blank",
    });

    try {
      render(<PreviewPanel threadId="thread-1" />);
      await screen.findByTestId("preview-webview");
      const hostedWebview = screen.getByTestId("electron-browser-surface-webview");
      fireEvent(hostedWebview, new Event("did-start-loading"));
      expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(
        "https://example.com/",
      );

      const titleEvent = new Event("page-title-updated") as Event & { title?: string };
      Object.defineProperty(titleEvent, "title", { value: "Example" });
      fireEvent(hostedWebview, titleEvent);
      expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe(
        "https://example.com/",
      );

      const blankEvent = new Event("did-navigate") as Event & { url?: string };
      Object.defineProperty(blankEvent, "url", { value: "about:blank" });
      fireEvent(hostedWebview, blankEvent);
      await waitFor(() => {
        expect(useDiffStore.getState().previewUrlByThread["thread-1"]).toBe("");
      });
    } finally {
      restoreWebviewMethods();
    }
  });

  it("keeps warm webview pages mounted and hydrates chrome while switching the active tab", async () => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ storedUrl: "https://a.example" }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "thread-1",
        activeTabId: "tab-a",
        tabs: [
          {
            id: "tab-a",
            threadId: "thread-1",
            title: "A",
            url: "https://a.example",
            faviconUrl: "https://a.example/favicon.ico",
            warm: true,
            active: true,
          },
          {
            id: "tab-b",
            threadId: "thread-1",
            title: "B",
            url: "https://b.example",
            faviconUrl: "https://b.example/favicon.ico",
            warm: true,
            active: false,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    const { rerender } = render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getAllByTestId("preview-webview")).toHaveLength(2);
    const webviewSurface = screen.getByTestId("preview-webview-surface");
    expect(webviewSurface).toHaveClass("pointer-events-none");
    expect(webviewSurface).toContainElement(
      screen.getAllByTestId("preview-webview")[0]!,
    );

    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "thread-1",
        activeTabId: "tab-b",
        tabs: [
          {
            id: "tab-a",
            threadId: "thread-1",
            title: "A",
            url: "https://a.example",
            faviconUrl: "https://a.example/favicon.ico",
            warm: true,
            active: false,
          },
          {
            id: "tab-b",
            threadId: "thread-1",
            title: "B",
            url: "https://b.example",
            faviconUrl: "https://b.example/favicon.ico",
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    rerender(<PreviewPanel threadId="thread-1" />);

    const webviews = screen.getAllByTestId("preview-webview");
    expect(webviews).toHaveLength(2);
    expect(webviews.map((node) => node.getAttribute("data-tab-id"))).toEqual([
      "tab-a",
      "tab-b",
    ]);
    expect(webviews[0]).toHaveAttribute("src", "https://a.example");
    expect(webviews[1]).toHaveAttribute("src", "https://b.example");
    const omnibox = screen.getByLabelText("Preview URL");
    await waitFor(() => expect(omnibox).toHaveValue("B"));
    expect(screen.getByTestId("browser-url-bar").querySelector("img")).toHaveAttribute(
      "src",
      "https://b.example/favicon.ico",
    );
    fireEvent.focus(omnibox);
    expect(omnibox).toHaveValue("https://b.example");
  });

  it("presents every warm tab in the hidden automation host", async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      left: 0,
      width: 1280,
      height: 720,
      toJSON: () => ({}),
    });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ storedUrl: "https://a.example" }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "thread-1",
        activeTabId: "tab-a",
        tabs: [
          { id: "tab-a", threadId: "thread-1", title: "A", url: "https://a.example", faviconUrl: null, warm: true, active: true },
          { id: "tab-b", threadId: "thread-1", title: "B", url: "https://b.example", faviconUrl: null, warm: true, active: false },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    render(<PreviewPanel threadId="thread-1" workspaceId="workspace-1" automationOnly />);

    await waitFor(() => expect(screen.getAllByTestId("electron-browser-surface-webview")).toHaveLength(2));
    expect(screen.getAllByTestId("electron-browser-surface-webview")).toEqual([
      expect.objectContaining({ style: expect.objectContaining({ visibility: "visible" }) }),
      expect.objectContaining({ style: expect.objectContaining({ visibility: "visible" }) }),
    ]);
    bounds.mockRestore();
  });

  it("persists favicon updates from inactive warm webview pages", async () => {
    const tabSet = {
      threadId: "thread-1",
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          threadId: "thread-1",
          title: "A",
          url: "https://a.example",
          faviconUrl: null,
          warm: true,
          active: true,
        },
        {
          id: "tab-b",
          threadId: "thread-1",
          title: "B",
          url: "https://b.example",
          faviconUrl: null,
          warm: true,
          active: false,
        },
      ],
    };
    usePreviewTabsStore.getState().setTabSet("thread-1", "thread-1", tabSet);
    mockUsePreviewTabs.mockReturnValue({
      tabSet,
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    render(<PreviewPanel threadId="thread-1" />);

    const inactiveWebview = screen
      .getAllByTestId("electron-browser-surface-webview")
      .find((node) => node.getAttribute("data-tab-id") === "tab-b")!;
    fireEvent(
      inactiveWebview,
      Object.assign(new Event("page-favicon-updated"), {
        favicons: ["https://b.example/favicon.ico"],
      }),
    );

    await waitFor(() => {
      const updatedTabSet = usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey("thread-1", "thread-1")]!;
      expect(updatedTabSet.tabs.find((tab) => tab.id === "tab-b")?.faviconUrl).toBe(
        "https://b.example/favicon.ico",
      );
    });
  });

  it("does not loop when equivalent active webview tab data is republished", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "https://a.example",
    });
    const setEquivalentTabs = () => {
      mockUsePreviewTabs.mockReturnValue({
        tabSet: {
          threadId: "thread-1",
          activeTabId: "tab-a",
          tabs: [
            {
              id: "tab-a",
              threadId: "thread-1",
              title: "A",
              url: "https://a.example",
              faviconUrl: null,
              warm: true,
              active: true,
            },
          ],
        },
        newTab: vi.fn(),
        activateTab: vi.fn(),
        closeTab: vi.fn(),
      });
    };

    try {
      setEquivalentTabs();
      const { rerender } = render(<PreviewPanel threadId="thread-1" />);

      setEquivalentTabs();
      rerender(<PreviewPanel threadId="thread-1" />);
      setEquivalentTabs();
      rerender(<PreviewPanel threadId="thread-1" />);

      expect(screen.getByTestId("preview-webview")).toHaveAttribute(
        "src",
        "https://a.example",
      );
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("Maximum update depth exceeded"),
      );
    } finally {
      restoreWebviewMethods();
      consoleError.mockRestore();
    }
  });

  it("navigates changed webview URLs through src without an extra loadURL call", async () => {
    const resolveNavigation = vi
      .fn()
      .mockResolvedValue({ ok: true, url: "https://about.google/" });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        storedUrl: "https://google.com/",
        resolveNavigation,
      }),
    );

    const loadURL = vi.fn().mockResolvedValue(undefined);
    const restoreWebviewMethods = installMockWebviewMethods({
      loadURL,
      getURL: () => "https://google.com/",
    });

    try {
      render(<PreviewPanel threadId="thread-1" />);
      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://google.com/",
        );
      });
      fireEvent(screen.getByTestId("preview-webview"), new Event("dom-ready"));

      const input = screen.getByLabelText("Preview URL");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "https://about.google/" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

      await waitFor(() => {
        expect(resolveNavigation).toHaveBeenCalledWith("https://about.google/");
      });
      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://about.google/",
        );
      });
      expect(loadURL).not.toHaveBeenCalled();
    } finally {
      restoreWebviewMethods();
    }
  });

  it("does not rewrite src when stored URL already matches the live webview URL", async () => {
    let liveUrl = "https://google.com/";
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => liveUrl,
    });

    try {
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: "https://google.com/" }),
      );
      const { rerender } = render(<PreviewPanel threadId="thread-1" />);
      const webview = screen.getByTestId("preview-webview");
      expect(webview).toHaveAttribute("src", "https://google.com/");

      liveUrl = "https://about.google/";
      fireEvent(
        screen.getByTestId("electron-browser-surface-webview"),
        Object.assign(new Event("did-navigate"), { url: liveUrl }),
      );
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: "https://about.google/" }),
      );
      rerender(<PreviewPanel threadId="thread-1" />);
      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://google.com/",
        );
      });
    } finally {
      restoreWebviewMethods();
    }
  });

  it("keeps one hosted placement mounted while its viewport coordinator registers", async () => {
    const threadId = "thread-adoption-stability";
    const tabId = "tab-adoption-stability";
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId,
        activeTabId: tabId,
        tabs: [
          {
            id: tabId,
            threadId,
            title: "Example",
            url: "https://example.com",
            faviconUrl: null,
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );
    const prepare = vi.mocked(window.desktopBridge!.preview!.surface.prepare);
    const release = vi.mocked(window.desktopBridge!.preview!.surface.release);

    render(<PreviewPanel threadId={threadId} workspaceId="workspace-1" />);
    const initialPlacement = screen.getByTestId("preview-webview");

    await waitFor(() => expect(prepare).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-webview")).toBe(initialPlacement);
  });

  it("does not feed an agent navigation redirect back into the webview src", async () => {
    const requestedUrl =
      "https://duckduckgo.com/?q=The+Left+Hand+of+Darkness+Ursula+K.+Le+Guin";
    const redirectedUrl = `${requestedUrl}&ia=web`;
    let liveUrl = requestedUrl;
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => liveUrl,
    });
    const tabs = (url: string) => ({
      tabSet: {
        threadId: "thread-1",
        activeTabId: "agent-tab",
        tabs: [{
          id: "agent-tab",
          threadId: "thread-1",
          title: "DuckDuckGo",
          url,
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    try {
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: requestedUrl }),
      );
      mockUsePreviewTabs.mockReturnValue(tabs(requestedUrl));
      const { rerender } = render(<PreviewPanel threadId="thread-1" />);
      const webview = screen.getByTestId("preview-webview");
      expect(webview).toHaveAttribute("src", requestedUrl);

      liveUrl = redirectedUrl;
      fireEvent(
        screen.getByTestId("electron-browser-surface-webview"),
        Object.assign(new Event("did-navigate"), { url: liveUrl }),
      );
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: redirectedUrl }),
      );
      mockUsePreviewTabs.mockReturnValue(tabs(redirectedUrl));
      rerender(<PreviewPanel threadId="thread-1" />);

      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          requestedUrl,
        );
      });
    } finally {
      restoreWebviewMethods();
    }
  });

  it("reloads instead of loadURL when navigating to the live webview URL", async () => {
    const resolveNavigation = vi
      .fn()
      .mockResolvedValue({ ok: true, url: "https://google.com/" });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        storedUrl: "https://google.com/",
        resolveNavigation,
      }),
    );

    const loadURL = vi.fn().mockResolvedValue(undefined);
    const navigateSurface = vi.mocked(window.desktopBridge!.preview!.surface.navigate);
    const restoreWebviewMethods = installMockWebviewMethods({
      loadURL,
      getURL: () => "https://google.com/",
    });

    try {
      render(<PreviewPanel threadId="thread-1" />);

      const input = screen.getByLabelText("Preview URL");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "https://google.com/" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

      await waitFor(() => {
        expect(resolveNavigation).toHaveBeenCalledWith("https://google.com/");
      });
      await waitFor(() => {
        expect(navigateSurface).toHaveBeenCalledWith(expect.objectContaining({
          navigation: { kind: "reload" },
        }));
      });
      expect(loadURL).not.toHaveBeenCalled();
    } finally {
      restoreWebviewMethods();
    }
  });

  it("keeps the live webview mounted while the overflow menu is open", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.getByTestId("preview-webview")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("More browser tools"));

    expect(await screen.findByTestId("browser-overflow-menu")).toBeInTheDocument();
    expect(screen.getByTestId("preview-webview")).toBeInTheDocument();
  });

  it("keeps browser chrome visible while design mode has no saved annotations", () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: "https://example.com/product-preview?productCode=QUAELE2010",
        storedUrl: "https://example.com/product-preview?productCode=QUAELE2010",
        pageStatus: {
          url: "https://example.com/product-preview?productCode=QUAELE2010",
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.getByTestId("browser-header")).toBeInTheDocument();
    expect(
      screen.queryByTestId("preview-annotation-header"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("preview-annotation-send-state"),
    ).not.toBeInTheDocument();
    const designButton = screen.getByRole("button", { name: "Design" });
    expect(designButton).toHaveAttribute("aria-pressed", "true");
    expect(designButton).toHaveTextContent("Design");
  });

  it("shows the saved-annotation command bar after the first annotation", () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.queryByTestId("browser-header")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-annotation-header")).toBeInTheDocument();
    expect(screen.getByTestId("preview-annotation-title")).toHaveTextContent(
      `Designing · ${normalizePreviewPageIdentity(pageUrl)}`,
    );
    expect(screen.getByTestId("preview-annotation-send-state")).toHaveAccessibleName(
      "Send 1 annotation",
    );
  });

  it("confirms before discarding saved page annotations", async () => {
    const user = userEvent.setup();
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    expect(usePreviewAnnotationStore.getState().byThread["thread-1"]).toHaveLength(
      1,
    );
    await user.click(screen.getByLabelText("Discard page annotations"));

    const cancelDialog = await screen.findByRole("dialog", {
      name: "Delete page annotations?",
    });
    expect(
      within(cancelDialog).getByText(
        "This removes 1 saved annotation from this page.",
      ),
    ).toBeInTheDocument();
    expect(usePreviewAnnotationStore.getState().byThread["thread-1"]).toHaveLength(
      1,
    );

    await user.click(within(cancelDialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Delete page annotations?" }),
      ).not.toBeInTheDocument();
    });
    expect(usePreviewAnnotationStore.getState().byThread["thread-1"]).toHaveLength(
      1,
    );

    await user.click(screen.getByLabelText("Discard page annotations"));
    const deleteDialog = await screen.findByRole("dialog", {
      name: "Delete page annotations?",
    });
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(usePreviewAnnotationStore.getState().byThread["thread-1"]).toHaveLength(
        0,
      );
    });
    expect(
      screen.queryByRole("button", { name: "Edit annotation 1" }),
    ).not.toBeInTheDocument();
  });

  it("hides saved annotation markers when design mode is inactive", () => {
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    expect(usePreviewAnnotationStore.getState().byThread["thread-1"]).toHaveLength(
      1,
    );
    expect(
      screen.queryByRole("button", { name: "Edit annotation 1" }),
    ).not.toBeInTheDocument();
  });

  it("shows saved annotations as numbered markers until reopened", () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    const marker = screen.getByRole("button", { name: "Edit annotation 1" });
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveTextContent("1");
    expect(
      screen.queryByTestId("preview-annotation-target-highlight"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("preview-annotation-active-target-highlight"),
    ).not.toBeInTheDocument();

    fireEvent.click(marker);

    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    expect(
      screen.getByTestId("preview-annotation-active-target-highlight"),
    ).toHaveStyle({
      left: "20px",
      top: "24px",
      width: "120px",
      height: "32px",
    });
  });

  it("shows saved annotation content when the marker is hovered", async () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    await userEvent.hover(screen.getByRole("button", { name: "Edit annotation 1" }));

    expect(await screen.findByText("Move this button")).toBeInTheDocument();
    expect(screen.getByText("button")).toBeInTheDocument();
  });

  it("keeps annotation advanced controls hidden in a new empty draft", () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Comment · / for skills · @ to mention")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-annotation-advanced")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preview-annotation-save")).not.toBeInTheDocument();
  });

  it("outlines the target while the draft annotation bubble is open", () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    expect(
      screen.getByTestId("preview-annotation-active-target-highlight"),
    ).toHaveStyle({
      left: "20px",
      top: "24px",
      width: "120px",
      height: "32px",
    });
  });

  it("shows annotation save only after note text or visual edits exist", () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.queryByTestId("preview-annotation-save")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Annotation note"), {
      target: { value: "Needs stronger contrast" },
    });
    expect(screen.getByTestId("preview-annotation-save")).toBeInTheDocument();
  });

  it("shakes before discarding a dirty draft from outside clicks", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.change(screen.getByLabelText("Annotation note"), {
      target: { value: "Needs stronger contrast" },
    });
    fireEvent.pointerDown(screen.getByTestId("preview-surface"));

    await waitFor(() => {
      expect(screen.getByTestId("preview-annotation-bubble")).toHaveClass(
        "animate-preview-annotation-shake",
      );
    });
    expect(
      screen.queryByText("Click outside again to discard"),
    ).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("preview-annotation-discard-overlay"));

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["thread-1"],
      ).toBeUndefined();
    });
    expect(
      screen.queryByTestId("preview-annotation-bubble"),
    ).not.toBeInTheDocument();
  });

  it("focuses the annotation note when a draft bubble opens", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Annotation note")).toHaveFocus();
    });
  });

  it("closes only the open annotation bubble on Escape", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["thread-1"],
      ).toBeUndefined();
    });
    expect(usePreviewDesignModeStore.getState().isActive("thread-1")).toBe(true);
    expect(
      screen.queryByTestId("preview-annotation-bubble"),
    ).not.toBeInTheDocument();
  });

  it("exits design mode on Escape when no annotation bubble is open", async () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(usePreviewDesignModeStore.getState().isActive("thread-1")).toBe(false);
    });
    expect(window.desktopBridge?.preview?.cancelCapture).toHaveBeenCalled();
  });

  it("handles app-level Escape without closing design mode when a bubble is open", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    const event = new CustomEvent("mcode:preview-design-escape", {
      cancelable: true,
      detail: { threadId: "thread-1" },
    });
    const notCancelled = window.dispatchEvent(event);

    expect(notCancelled).toBe(false);
    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["thread-1"],
      ).toBeUndefined();
    });
    expect(usePreviewDesignModeStore.getState().isActive("thread-1")).toBe(true);
  });

  it("keeps the open annotation when the rail maximize control is clicked", () => {
    installDraftAnnotation();
    const maximize = document.createElement("button");
    maximize.setAttribute("data-preview-design-keep-open", "true");
    document.body.append(maximize);

    try {
      render(<PreviewPanel threadId="thread-1" />);

      fireEvent.pointerDown(maximize);

      expect(usePreviewAnnotationStore.getState().drafts["thread-1"]).toBeDefined();
      expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    } finally {
      maximize.remove();
    }
  });

  it("discards an unsaved draft when design mode exits from browser chrome", async () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Design" }));

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["thread-1"],
      ).toBeUndefined();
    });
    expect(
      screen.queryByTestId("preview-annotation-bubble"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("saves the annotation when Enter is pressed in the note", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "Use stronger contrast" } });
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().byThread["thread-1"],
      ).toHaveLength(1);
    });
    expect(mockCaptureAnnotationSnapshot).toHaveBeenCalledWith({
      activeDisplayNumber: 1,
      activeBounds: { x: 20, y: 24, width: 120, height: 32 },
      markers: [
        {
          displayNumber: 1,
          bounds: { x: 20, y: 24, width: 120, height: 32 },
        },
      ],
    });
    expect(
      usePreviewAnnotationStore.getState().byThread["thread-1"]?.[0]?.note,
    ).toBe("Use stronger contrast");
  });

  it("captures a new annotation with only its target highlighted and prior markers visible", async () => {
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );
    installSavedAnnotation();
    installDraftAnnotation({
      pageIdentity: normalizePreviewPageIdentity(pageUrl),
      bounds: { x: 200, y: 120, width: 180, height: 44 },
      pageContext: {
        schemaVersion: 2,
        pageUrl,
        pageTitle: "Example",
        capturedAt: "2026-07-01T00:00:00.000Z",
        captureKind: "element",
        bounds: { x: 200, y: 120, width: 180, height: 44 },
        layoutViewport: { width: 800, height: 600 },
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "Move this search input" } });
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockCaptureAnnotationSnapshot).toHaveBeenCalledWith({
        activeDisplayNumber: 2,
        activeBounds: { x: 200, y: 120, width: 180, height: 44 },
        markers: [
          {
            displayNumber: 1,
            bounds: { x: 20, y: 24, width: 120, height: 32 },
          },
          {
            displayNumber: 2,
            bounds: { x: 200, y: 120, width: 180, height: 44 },
          },
        ],
      });
    });
  });

  it("saves and requests composer send when Ctrl+Enter is pressed", async () => {
    const submitSpy = vi.fn();
    window.addEventListener("mcode:submit-composer", submitSpy);
    installDraftAnnotation();

    try {
      render(<PreviewPanel threadId="thread-1" />);

      const note = screen.getByLabelText("Annotation note");
      fireEvent.change(note, { target: { value: "Move this button" } });
      fireEvent.keyDown(note, {
        key: "Enter",
        code: "Enter",
        ctrlKey: true,
      });

      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledTimes(1);
      });
      const event = submitSpy.mock.calls[0]?.[0] as CustomEvent<{
        threadId?: string;
      }>;
      expect(event.detail.threadId).toBe("thread-1");
    } finally {
      window.removeEventListener("mcode:submit-composer", submitSpy);
    }
  });

  it("guards the page while a design-mode annotation bubble is open", async () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    installDraftAnnotation();

    const { unmount } = render(<PreviewPanel threadId="thread-1" />);

    const setAnnotationGuard = vi.mocked(
      window.desktopBridge!.preview!.design.setAnnotationGuard,
    );
    await waitFor(() => {
      expect(setAnnotationGuard).toHaveBeenCalledWith(true);
    });

    unmount();

    await waitFor(() => {
      expect(setAnnotationGuard).toHaveBeenCalledWith(false);
    });
  });

  it("re-arms the element picker after saving a design-mode annotation", async () => {
    usePreviewDesignModeStore.getState().setActive("thread-1", true);
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    expect(mockOnAddElementAnnotation).not.toHaveBeenCalled();
    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "Tighten spacing" } });
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockOnAddElementAnnotation).toHaveBeenCalledTimes(1);
    });
  });

  it("opens compact advanced annotation controls from the tuning action", () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));

    expect(screen.getByTestId("preview-annotation-advanced")).toBeInTheDocument();
    expect(screen.getByLabelText("Delete annotation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("prefills advanced annotation controls from the selected element style", () => {
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 255, 255)",
        background: "rgb(10, 52, 92)",
        opacity: 0.75,
        font: "Inter, sans-serif",
        fontSize: "14px",
        width: "120px",
        height: "32px",
        padding: "20px 96px",
        margin: "0px",
        borderWidth: "1px 2px 3px 4px",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");

    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "rgb(255, 255, 255)",
    );
    expect(within(advanced).getByLabelText("Background")).toHaveValue(
      "rgb(10, 52, 92)",
    );
    expect(within(advanced).getByLabelText("Opacity")).toHaveValue("0.75");
    expect(within(advanced).getByLabelText("Font")).toHaveValue(
      "Inter, sans-serif",
    );
    expect(within(advanced).getByLabelText(/Font size/)).toHaveValue("14");
    expect(within(advanced).getByLabelText("Padding left")).toHaveValue("96");
    expect(within(advanced).getByLabelText("Padding top")).toHaveValue("20");
    expect(within(advanced).getByLabelText("Margin right")).toHaveValue("0");
    expect(within(advanced).getByLabelText("Border left")).toHaveValue("4");
    expect(screen.queryByTestId("preview-annotation-save")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.queryByTestId("preview-annotation-visual-proposal"),
    ).not.toBeInTheDocument();
  });

  it("allows opacity decimals while editing", () => {
    installDraftAnnotation({
      elementStyle: {
        opacity: 1,
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const opacity = within(
      screen.getByTestId("preview-annotation-advanced"),
    ).getByLabelText("Opacity");

    fireEvent.change(opacity, { target: { value: "." } });
    expect(opacity).toHaveValue(".");

    fireEvent.change(opacity, { target: { value: "0.5" } });
    expect(opacity).toHaveValue("0.5");
    expect(screen.getByTestId("preview-annotation-visual-proposal")).toHaveStyle({
      opacity: "0.5",
    });
  });

  it("links width and height edits when the size anchor is active", () => {
    installDraftAnnotation({
      elementStyle: {
        width: "120px",
        height: "32px",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    fireEvent.click(within(advanced).getByLabelText("Link width and height"));
    fireEvent.change(within(advanced).getByLabelText("Width"), {
      target: { value: "160" },
    });

    expect(within(advanced).getByLabelText("Height")).toHaveValue("160");
    expect(screen.getByTestId("preview-annotation-visual-proposal")).toHaveStyle({
      width: "160px",
      height: "160px",
    });
  });

  it("expands box controls and links paired padding values", () => {
    installDraftAnnotation({
      elementStyle: {
        paddingTop: "0px",
        paddingBottom: "0px",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    fireEvent.click(within(advanced).getByRole("button", { name: "Padding" }));
    fireEvent.click(within(advanced).getByLabelText("Link padding top and bottom"));
    fireEvent.change(within(advanced).getByLabelText("Padding top"), {
      target: { value: "12" },
    });

    expect(within(advanced).getByLabelText("Padding bottom")).toHaveValue("12");
  });

  it("prefills expandable border radius corner controls", () => {
    installDraftAnnotation({
      elementStyle: {
        borderRadius: "4px 8px 12px 16px",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    fireEvent.click(within(advanced).getByRole("button", { name: "Radius" }));

    expect(within(advanced).getByLabelText("Radius top left")).toHaveValue("4");
    expect(within(advanced).getByLabelText("Radius top right")).toHaveValue("8");
    expect(within(advanced).getByLabelText("Radius bottom right")).toHaveValue("12");
    expect(within(advanced).getByLabelText("Radius bottom left")).toHaveValue("16");
  });

  it("formats color controls across RGB, HSL, and HEX", async () => {
    const user = userEvent.setup();
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 255, 255)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Text color picker"));
    await user.click(await screen.findByLabelText("Use HEX for Text color"));

    await waitFor(() => {
      expect(within(advanced).getByLabelText("Text color")).toHaveValue("#FFFFFF");
    });

    fireEvent.change(screen.getByLabelText("Color picker for Text color"), {
      target: { value: "#336699" },
    });
    expect(within(advanced).getByLabelText("Text color")).toHaveValue("#336699");

    await user.click(screen.getByLabelText("Use HSL for Text color"));
    await waitFor(() => {
      expect(within(advanced).getByLabelText("Text color")).toHaveValue(
        "hsl(210, 50%, 40%)",
      );
    });
  });

  it("renders the rich color picker inline without a native color input gate", async () => {
    const user = userEvent.setup();
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 255, 255)",
        background: "rgb(10, 52, 92)",
        borderColor: "rgb(10, 52, 92)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Text color picker"));

    expect(screen.getByLabelText("Saturation and value for Text color")).toBeInTheDocument();
    expect(screen.getByLabelText("Hue for Text color")).toBeInTheDocument();
    expect(screen.getByLabelText("Text color R")).toBeInTheDocument();
    expect(screen.getByTestId("preview-color-popover-textColor")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("#ffffff")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="color"]')).toBeNull();
  });

  it("keeps the screen color picker available inside the rich color picker", async () => {
    const user = userEvent.setup();
    const openEyeDropper = vi.fn().mockResolvedValue({ sRGBHex: "#123456" });
    const EyeDropperMock = vi.fn(function () {
      return { open: openEyeDropper };
    });
    Object.defineProperty(window, "EyeDropper", {
      configurable: true,
      value: EyeDropperMock,
    });
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 255, 255)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Text color picker"));
    await user.click(screen.getByLabelText("Pick Text color from screen"));

    await waitFor(() => expect(openEyeDropper).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(within(advanced).getByLabelText("Text color")).toHaveValue(
        "rgb(18, 52, 86)",
      );
    });

    Reflect.deleteProperty(window, "EyeDropper");
  });

  it("disables the screen color picker when the browser API is unavailable", async () => {
    const user = userEvent.setup();
    Reflect.deleteProperty(window, "EyeDropper");
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 255, 255)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Text color picker"));

    const eyedropper = screen.getByLabelText("Pick Text color from screen");
    expect(eyedropper).toBeDisabled();

    await user.hover(eyedropper.parentElement ?? eyedropper);
    expect(
      await screen.findByText("Screen color picker unavailable"),
    ).toBeInTheDocument();
  });

  it("updates annotation color from the inline saturation plane and hue control", async () => {
    const user = userEvent.setup();
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 0, 0)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Text color picker"));

    const plane = screen.getByTestId("preview-color-plane-textColor");
    vi.spyOn(plane, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      right: 100,
      bottom: 100,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(plane, { clientX: 50, clientY: 50, pointerId: 1 });

    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "rgb(128, 64, 64)",
    );
    expect(screen.getByTestId("preview-annotation-visual-proposal")).toHaveStyle({
      color: "rgb(128, 64, 64)",
    });

    const hue = screen.getByTestId("preview-color-hue-textColor");
    vi.spyOn(hue, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 10,
      top: 0,
      right: 100,
      bottom: 10,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(hue, { clientX: 33, clientY: 5, pointerId: 2 });

    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "rgb(65, 128, 64)",
    );
  });

  it("updates annotation color from keyboard input on the inline color controls", async () => {
    const user = userEvent.setup();
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 0, 0)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Text color picker"));

    const plane = screen.getByTestId("preview-color-plane-textColor");
    expect(plane).toHaveAttribute("role", "slider");
    expect(plane).toHaveAttribute("aria-valuemin", "0");
    expect(plane).toHaveAttribute("aria-valuemax", "100");
    expect(plane).toHaveAttribute("aria-valuenow", "100");

    fireEvent.keyDown(plane, { key: "ArrowLeft", code: "ArrowLeft" });

    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "rgb(255, 3, 3)",
    );
    expect(plane).toHaveAttribute("aria-valuenow", "99");

    fireEvent.keyDown(plane, { key: "Home", code: "Home" });

    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "rgb(0, 0, 0)",
    );
    expect(plane).toHaveAttribute("aria-valuenow", "0");

    fireEvent.keyDown(plane, { key: "End", code: "End" });

    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "rgb(255, 0, 0)",
    );
    expect(plane).toHaveAttribute("aria-valuenow", "100");

    const hue = screen.getByTestId("preview-color-hue-textColor");
    expect(hue).toHaveAttribute("role", "slider");
    expect(hue).toHaveAttribute("aria-valuemin", "0");
    expect(hue).toHaveAttribute("aria-valuemax", "360");
    expect(hue).toHaveAttribute("aria-valuenow", "0");

    fireEvent.keyDown(hue, { key: "ArrowRight", code: "ArrowRight" });

    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "rgb(255, 4, 0)",
    );
    expect(hue).toHaveAttribute("aria-valuenow", "1");
  });

  it("opens and updates the Background color picker while preserving rgba alpha", async () => {
    const user = userEvent.setup();
    installDraftAnnotation({
      elementStyle: {
        background: "rgba(10, 20, 30, 0.5)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Background picker"));

    expect(screen.getByLabelText("Saturation and value for Background")).toBeInTheDocument();
    expect(screen.getByLabelText("Hue for Background")).toBeInTheDocument();
    expect(screen.getByTestId("preview-color-popover-background")).toBeInTheDocument();
    expect(screen.getByLabelText("Background R")).toHaveValue("10");
    expect(within(advanced).getByLabelText("Background")).toHaveValue(
      "rgba(10, 20, 30, 0.5)",
    );

    const plane = screen.getByTestId("preview-color-plane-background");
    vi.spyOn(plane, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      right: 100,
      bottom: 100,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(plane, { clientX: 100, clientY: 0, pointerId: 3 });

    expect(within(advanced).getByLabelText("Background")).toHaveValue(
      "rgba(0, 128, 255, 0.5)",
    );
    expect(screen.getByTestId("preview-annotation-visual-proposal")).toHaveStyle({
      background: "rgba(0, 128, 255, 0.5)",
    });
  });

  it("opens and updates the Border color picker from an hsla baseline", async () => {
    const user = userEvent.setup();
    installDraftAnnotation({
      elementStyle: {
        borderColor: "hsla(210, 50%, 40%, 0.25)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Border color picker"));

    expect(screen.getByLabelText("Saturation and value for Border color")).toBeInTheDocument();
    expect(screen.getByLabelText("Hue for Border color")).toBeInTheDocument();
    expect(screen.getByTestId("preview-color-popover-borderColor")).toBeInTheDocument();
    expect(within(advanced).getByLabelText("Border color")).toHaveValue(
      "hsla(210, 50%, 40%, 0.25)",
    );

    await user.click(screen.getByLabelText("Use RGB for Border color"));
    await waitFor(() => {
      expect(within(advanced).getByLabelText("Border color")).toHaveValue(
        "rgba(51, 102, 153, 0.25)",
      );
    });

    fireEvent.change(screen.getByLabelText("Border color R"), {
      target: { value: "64" },
    });
    expect(within(advanced).getByLabelText("Border color")).toHaveValue(
      "rgba(64, 102, 153, 0.25)",
    );
    expect(screen.getByTestId("preview-annotation-visual-proposal")).toHaveStyle({
      borderColor: "rgba(64, 102, 153, 0.25)",
    });
  });

  it("keeps the color popover open while changing formats and editing fields", async () => {
    const user = userEvent.setup();
    installDraftAnnotation({
      elementStyle: {
        textColor: "hsl(0, 50%, 50%)",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    const advanced = screen.getByTestId("preview-annotation-advanced");
    await user.click(within(advanced).getByLabelText("Open Text color picker"));

    expect(screen.getByTestId("preview-color-popover-textColor")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Use HSL for Text color"));
    expect(screen.getByTestId("preview-color-popover-textColor")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Text color H"), {
      target: { value: "210" },
    });
    expect(screen.getByTestId("preview-color-popover-textColor")).toBeInTheDocument();
    expect(within(advanced).getByLabelText("Text color")).toHaveValue(
      "hsl(210, 50%, 50%)",
    );
  });

  it("updates the active visual highlight as side controls change", () => {
    installDraftAnnotation({
      elementStyle: {
        paddingLeft: "20px",
        paddingRight: "20px",
        paddingTop: "0px",
        paddingBottom: "0px",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    fireEvent.change(
      within(screen.getByTestId("preview-annotation-advanced")).getByLabelText(
        "Padding left",
      ),
      { target: { value: "40px" } },
    );

    expect(screen.getByTestId("preview-annotation-visual-proposal")).toHaveStyle({
      left: "0px",
      top: "24px",
      width: "140px",
      height: "32px",
    });
  });

  it("saves only advanced fields changed away from the selected element style", async () => {
    installDraftAnnotation({
      elementStyle: {
        textColor: "rgb(255, 255, 255)",
        background: "rgb(10, 52, 92)",
        opacity: 0.75,
        fontSize: "14px",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    fireEvent.change(
      within(screen.getByTestId("preview-annotation-advanced")).getByLabelText(
        /Font size/,
      ),
      { target: { value: "18px" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(usePreviewAnnotationStore.getState().byThread["thread-1"]).toHaveLength(1);
    });
    expect(
      usePreviewAnnotationStore.getState().byThread["thread-1"]?.[0]?.proposedChanges,
    ).toEqual({ fontSize: "18px" });
  });

  it("saves side-control changes and captures their adjusted highlight bounds", async () => {
    installDraftAnnotation({
      elementStyle: {
        paddingLeft: "20px",
        paddingRight: "20px",
        paddingTop: "0px",
        paddingBottom: "0px",
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    fireEvent.click(screen.getByLabelText("Open annotation visual controls"));
    fireEvent.change(
      within(screen.getByTestId("preview-annotation-advanced")).getByLabelText(
        "Padding left",
      ),
      { target: { value: "40px" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(usePreviewAnnotationStore.getState().byThread["thread-1"]).toHaveLength(1);
    });
    expect(
      usePreviewAnnotationStore.getState().byThread["thread-1"]?.[0]?.proposedChanges,
    ).toEqual({ paddingLeft: "40px" });
    expect(mockCaptureAnnotationSnapshot).toHaveBeenCalledWith({
      activeDisplayNumber: 1,
      activeBounds: { x: 0, y: 24, width: 140, height: 32 },
      markers: [
        {
          displayNumber: 1,
          bounds: { x: 20, y: 24, width: 120, height: 32 },
        },
      ],
    });
  });

  // ---------------------------------------------------------------------------
  // Annotation bubble slash-command popup
  // ---------------------------------------------------------------------------

  it("opens the slash-command popup when '/' is typed in the annotation note", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    const note = screen.getByLabelText("Annotation note");
    // onChange reads selectionStart ?? value.length; jsdom returns null for
    // selectionStart on a synthetic change event, so it falls back to
    // value.length (1 for "/"). SLASH_TRIGGER_RE matches "/" at cursor 1.
    fireEvent.change(note, { target: { value: "/" } });

    // Skills load is async; wait for the popup to become ready.
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    });
  });

  it("closes the slash-command popup when Escape is pressed in the annotation note", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "/" } });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    });

    // Escape must dismiss the popup without discarding the bubble.
    fireEvent.keyDown(note, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    });
    // The annotation bubble must remain open after a popup Escape.
    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
  });

  it("inserts the selected command text on Enter and does NOT save the annotation", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "/" } });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    });

    // Enter selects the first item and inserts it as plain text. It must NOT
    // save the annotation (no annotation should be saved to byThread).
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    // The annotation store must still be empty (not saved).
    expect(
      usePreviewAnnotationStore.getState().byThread["thread-1"],
    ).toBeUndefined();
    // The popup must be dismissed after selection.
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    });
  });

  it("does not include builtin mcode commands in the annotation note popup", async () => {
    // Override skills to be empty so only builtins would appear if they were
    // included; with includeBuiltins: false the popup renders the empty state
    // instead of a list. Confirms builtins don't leak into the annotation popup.
    mockGetProviderCatalog.mockResolvedValueOnce({
      providerId: "claude",
      context: { scope: "user" },
      freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
      diagnostics: [],
      entries: [],
      selectableAgents: [],
    });
    useProviderCatalogStore.getState().reset();

    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "/" } });

    // With no skills and no builtins, the popup shows the empty state, not a
    // listbox. Builtins (plan, compact, goal) must not appear.
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
      // The popup is still rendered (closed state would remove it entirely) but
      // shows an empty-state status instead of items.
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  it("Ctrl+Enter saves the annotation while the popup is closed", async () => {
    const submitSpy = vi.fn();
    window.addEventListener("mcode:submit-composer", submitSpy);
    installDraftAnnotation();

    try {
      render(<PreviewPanel threadId="thread-1" />);

      const note = screen.getByLabelText("Annotation note");
      fireEvent.change(note, { target: { value: "Use stronger contrast" } });
      // Ctrl+Enter saves when popup is NOT open.
      fireEvent.keyDown(note, { key: "Enter", code: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(
          usePreviewAnnotationStore.getState().byThread["thread-1"],
        ).toHaveLength(1);
      });
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("mcode:submit-composer", submitSpy);
    }
  });
});
