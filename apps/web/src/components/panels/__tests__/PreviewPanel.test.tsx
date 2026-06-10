/**
 * Composition tests for PreviewPanel.
 *
 * Covers the two rendering paths:
 * 1. Unavailable state - when desktopBridge.preview is absent.
 * 2. Full panel state - when desktopBridge.preview is present (hooks mocked).
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock hooks before importing the component under test.
vi.mock("../hooks/usePreviewBridge", () => ({
  usePreviewBridge: () => ({
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
    onNavigate: vi.fn(),
    onRetry: vi.fn(),
  }),
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

import { PreviewPanel } from "../PreviewPanel";

describe("PreviewPanel — unavailable state", () => {
  beforeEach(() => {
    // Ensure no desktopBridge is present.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
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
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
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
});
