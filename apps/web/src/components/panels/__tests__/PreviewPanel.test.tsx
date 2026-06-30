/**
 * Composition tests for PreviewPanel.
 *
 * Covers the two rendering paths:
 * 1. Unavailable state - when desktopBridge.preview is absent.
 * 2. Full panel state - when desktopBridge.preview is present (hooks mocked).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";

const { mockUsePreviewBridge } = vi.hoisted(() => ({
  mockUsePreviewBridge: vi.fn(),
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
  }),
}));

import {
  PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
  PreviewPanel,
  shouldRenderWebviewPreview,
} from "../PreviewPanel";
import { useSettingsStore } from "@/stores/settingsStore";
import { usePreviewSuppressionStore } from "@/stores/previewSuppressionStore";

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
      },
    };
    useSettingsStore.getState()._applyPush(getDefaultSettings());
    usePreviewSuppressionStore.setState({ count: 0 });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    useSettingsStore.getState()._applyPush(getDefaultSettings());
    usePreviewSuppressionStore.setState({ count: 0 });
    mockUsePreviewBridge.mockClear();
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
});
