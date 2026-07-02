/**
 * Composition tests for PreviewPanel.
 *
 * Covers the two rendering paths:
 * 1. Unavailable state - when desktopBridge.preview is absent.
 * 2. Full panel state - when desktopBridge.preview is present (hooks mocked).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";

const {
  mockUsePreviewBridge,
  mockOnAddElementAnnotation,
  mockCaptureAnnotationSnapshot,
} = vi.hoisted(() => ({
  mockUsePreviewBridge: vi.fn(),
  mockOnAddElementAnnotation: vi.fn(),
  mockCaptureAnnotationSnapshot: vi.fn(),
}));

// Mock hooks before importing the component under test.
vi.mock("../hooks/usePreviewBridge", () => ({
  usePreviewBridge: mockUsePreviewBridge,
  formatNavError: (code: string) => code,
}));

// The panel only consumes usePreviewTabs for the header's "New page" action and
// the store subscription; page switching/closing lives in the activity rail.
vi.mock("../hooks/usePreviewTabs", () => ({
  usePreviewTabs: () => ({
    tabSet: null,
    newTab: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
  }),
}));

vi.mock("../hooks/usePreviewCapture", () => ({
  usePreviewCapture: () => ({
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
  }),
}));

import {
  PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
  PreviewPanel,
  shouldRenderWebviewPreview,
} from "../PreviewPanel";
import { useSettingsStore } from "@/stores/settingsStore";
import { usePreviewSuppressionStore } from "@/stores/previewSuppressionStore";
import {
  normalizePreviewPageIdentity,
  usePreviewAnnotationStore,
} from "@/stores/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";

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
  };
  const loadURLDescriptor = Object.getOwnPropertyDescriptor(proto, "loadURL");
  const getURLDescriptor = Object.getOwnPropertyDescriptor(proto, "getURL");
  const getWebContentsIdDescriptor = Object.getOwnPropertyDescriptor(
    proto,
    "getWebContentsId",
  );
  const reloadDescriptor = Object.getOwnPropertyDescriptor(proto, "reload");
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
  };
}

function installDraftAnnotation(overrides: Record<string, unknown> = {}) {
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

describe("PreviewPanel — unavailable state", () => {
  beforeEach(() => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
    // Ensure no desktopBridge is present.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    mockUsePreviewBridge.mockClear();
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
});

describe("PreviewPanel — full panel state", () => {
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
        adoptWebview: vi.fn().mockResolvedValue(undefined),
        releaseWebview: vi.fn().mockResolvedValue(undefined),
        design: {
          setAnnotationGuard: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    };
    mockOnAddElementAnnotation.mockResolvedValue({ ok: true });
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
    usePreviewSuppressionStore.setState({ count: 0 });
    usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
    usePreviewDesignModeStore.setState({ modes: {} });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    useSettingsStore.getState()._applyPush(getDefaultSettings());
    usePreviewSuppressionStore.setState({ count: 0 });
    usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
    usePreviewDesignModeStore.setState({ modes: {} });
    mockUsePreviewBridge.mockClear();
    mockOnAddElementAnnotation.mockClear();
    mockCaptureAnnotationSnapshot.mockClear();
  });

  it("renders the full panel when desktopBridge is present", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
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

  it("uses the native preview path by default", () => {
    render(<PreviewPanel threadId="thread-1" />);
    expect(screen.queryByTestId("preview-webview-surface")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-local-ports")).toBeInTheDocument();
    expect(screen.getByTestId("preview-surface")).toHaveClass(
      "mx-2",
      "mb-2",
      "mt-1",
      "rounded-md",
      "border",
      "bg-muted/10",
    );
  });

  it("keeps the webview path flush while preserving the empty state", () => {
    useSettingsStore.getState()._applyPush({
      ...getDefaultSettings(),
      preview: {
        ...getDefaultSettings().preview,
        rendering: { engine: "webview" },
      },
    });

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.getByTestId("preview-webview-surface")).toBeInTheDocument();
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
      expect.objectContaining({ forceHidden: true }),
    );
  });

  it("renders the active URL in a live webview when the effective engine is webview", () => {
    useSettingsStore.getState()._applyPush({
      ...getDefaultSettings(),
      preview: {
        ...getDefaultSettings().preview,
        rendering: { engine: "webview" },
      },
    });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    const webview = screen.getByTestId("preview-webview");
    expect(webview).toHaveAttribute("data-tab-id", PREVIEW_WEBVIEW_FALLBACK_TAB_ID);
    expect(webview).toHaveAttribute("src", "https://example.com");
    expect(webview).toHaveClass("relative", "z-0", "h-full", "w-full");
    expect(screen.queryByTestId("browser-local-ports")).not.toBeInTheDocument();
    expect(mockUsePreviewBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceHidden: true }),
    );
  });

  it("navigates changed webview URLs through src without an extra loadURL call", async () => {
    useSettingsStore.getState()._applyPush({
      ...getDefaultSettings(),
      preview: {
        ...getDefaultSettings().preview,
        rendering: { engine: "webview" },
      },
    });
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
    useSettingsStore.getState()._applyPush({
      ...getDefaultSettings(),
      preview: {
        ...getDefaultSettings().preview,
        rendering: { engine: "webview" },
      },
    });
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

  it("reloads instead of loadURL when navigating to the live webview URL", async () => {
    useSettingsStore.getState()._applyPush({
      ...getDefaultSettings(),
      preview: {
        ...getDefaultSettings().preview,
        rendering: { engine: "webview" },
      },
    });
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
    const reload = vi.fn();
    const restoreWebviewMethods = installMockWebviewMethods({
      loadURL,
      reload,
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
        expect(reload).toHaveBeenCalledTimes(1);
      });
      expect(loadURL).not.toHaveBeenCalled();
    } finally {
      restoreWebviewMethods();
    }
  });

  it("keeps the live webview mounted while the overflow menu is open", async () => {
    useSettingsStore.getState()._applyPush({
      ...getDefaultSettings(),
      preview: {
        ...getDefaultSettings().preview,
        rendering: { engine: "webview" },
      },
    });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );

    render(<PreviewPanel threadId="thread-1" />);

    expect(screen.getByTestId("preview-webview")).toBeInTheDocument();
    expect(usePreviewSuppressionStore.getState().count).toBe(0);
    fireEvent.click(screen.getByLabelText("More browser tools"));

    expect(await screen.findByTestId("browser-overflow-menu")).toBeInTheDocument();
    expect(screen.getByTestId("preview-webview")).toBeInTheDocument();
    expect(usePreviewSuppressionStore.getState().count).toBe(0);
  });

  it("honors the webview engine in built and dev renderers", () => {
    expect(shouldRenderWebviewPreview("webview")).toBe(true);
    expect(shouldRenderWebviewPreview("webContentsView")).toBe(false);
    expect(shouldRenderWebviewPreview(undefined)).toBe(false);
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

  it("shows saved annotations as numbered markers until reopened", () => {
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
    expect(screen.getByPlaceholderText("Add a comment...")).toBeInTheDocument();
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

  it("focuses the annotation note when a draft bubble opens", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="thread-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Annotation note")).toHaveFocus();
    });
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
    expect(
      usePreviewAnnotationStore.getState().byThread["thread-1"]?.[0]?.note,
    ).toBe("Use stronger contrast");
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
});
