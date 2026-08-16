import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME } from "@mcode/contracts";
import { usePreviewCapture } from "../usePreviewCapture";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";

// ---------------------------------------------------------------------------
// Store mocks — must be declared before the module is imported.
// ---------------------------------------------------------------------------

const mockShow = vi.fn();
const mockEnqueue = vi.fn();

vi.mock("@/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ show: mockShow }) },
}));

vi.mock("../../state/previewReferenceQueueStore", () => ({
  usePreviewReferenceQueueStore: {
    getState: () => ({ enqueuePreviewReference: mockEnqueue }),
  },
}));

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

/** Minimal successful full-viewport capture result. */
function makeCapturePngResult(overrides?: object) {
  return {
    ok: true as const,
    meta: {
      id: "capture-id-1",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      sourcePath: "/tmp/capture.png",
    },
    previewBytes: new Uint8Array([1, 2, 3]),
    capture: {} as never,
    ...overrides,
  };
}

/** Minimal successful page-context capture result. */
function makeContextResult(overrides?: object) {
  return {
    ok: true as const,
    capture: {} as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const mockPreview = {
  capturePictureReference: vi.fn(),
  capturePictureReferenceRegion: vi.fn(),
  capturePictureReferenceElementPick: vi.fn(),
  captureAnnotationSnapshot: vi.fn(),
  capturePageContext: vi.fn(),
};

const THREAD_ID = "thread-abc";
const defaultOptions = () => ({
  threadId: THREAD_ID,
  pushSync: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  window.desktopBridge = {
    preview: mockPreview,
  } as unknown as typeof window.desktopBridge;
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });

  // jsdom does not implement URL.createObjectURL
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).desktopBridge;
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Tests for the usePreviewCapture hook.
 * Covers initial state, all four capture handlers, error paths, and busy state
 * composition (anyCaptureActive).
 */
describe("usePreviewCapture", () => {
  describe("initial state", () => {
    it("returns all busy flags as false and anyCaptureActive as false", () => {
      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      expect(result.current.captureBusy).toBe(false);
      expect(result.current.regionBusy).toBe(false);
      expect(result.current.elementPickBusy).toBe(false);
      expect(result.current.contextBusy).toBe(false);
      expect(result.current.anyCaptureActive).toBe(false);
    });

    it("exposes all four handler functions", () => {
      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      expect(typeof result.current.onAddPictureReference).toBe("function");
      expect(typeof result.current.onAddRegionPictureReference).toBe("function");
      expect(typeof result.current.onAddElementPickPictureReference).toBe("function");
      expect(typeof result.current.onAddPageContextOnly).toBe("function");
      expect(typeof result.current.captureAnnotationSnapshot).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // onAddPictureReference
  // -------------------------------------------------------------------------

  describe("onAddPictureReference", () => {
    it("calls pushSync(true) before capturePictureReference", async () => {
      const opts = defaultOptions();
      const pushSync = opts.pushSync;
      mockPreview.capturePictureReference.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(pushSync).toHaveBeenCalledWith(true);
      const pushOrder = pushSync.mock.invocationCallOrder[0];
      const captureOrder = mockPreview.capturePictureReference.mock.invocationCallOrder[0];
      expect(pushOrder).toBeLessThan(captureOrder);
    });

    it("enqueues the attachment on success", async () => {
      mockPreview.capturePictureReference.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(mockEnqueue).toHaveBeenCalledOnce();
      const [calledThreadId, attachment] = mockEnqueue.mock.calls[0] as [string, unknown];
      expect(calledThreadId).toBe(THREAD_ID);
      expect(attachment).toMatchObject({
        id: "capture-id-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 3,
      });
    });

    it("resets captureBusy to false after success", async () => {
      mockPreview.capturePictureReference.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(result.current.captureBusy).toBe(false);
    });

    it("shows a toast on error result (non-silent code)", async () => {
      mockPreview.capturePictureReference.mockResolvedValue({
        ok: false,
        error: "capture-failed",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(mockShow).toHaveBeenCalledOnce();
      expect(mockShow).toHaveBeenCalledWith("error", "Could not capture preview", expect.any(String));
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("does NOT show a toast for silent error 'cancelled'", async () => {
      mockPreview.capturePictureReference.mockResolvedValue({
        ok: false,
        error: "cancelled",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("does NOT show a toast for silent error 'capture-interrupted'", async () => {
      mockPreview.capturePictureReference.mockResolvedValue({
        ok: false,
        error: "capture-interrupted",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(mockShow).not.toHaveBeenCalled();
    });

    it("does NOT show a toast for silent error 'navigated-away'", async () => {
      mockPreview.capturePictureReference.mockResolvedValue({
        ok: false,
        error: "navigated-away",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(mockShow).not.toHaveBeenCalled();
    });

    it("shows a toast and resets busy when capturePictureReference throws", async () => {
      mockPreview.capturePictureReference.mockRejectedValue(new Error("IPC failure"));

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(mockShow).toHaveBeenCalledWith("error", "Could not capture preview", "Screenshot failed.");
      expect(result.current.captureBusy).toBe(false);
    });

    it("does nothing when desktopBridge is absent", async () => {
      delete (window as unknown as Record<string, unknown>).desktopBridge;

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPictureReference();
      });

      expect(mockPreview.capturePictureReference).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onAddRegionPictureReference
  // -------------------------------------------------------------------------

  describe("onAddRegionPictureReference", () => {
    it("calls pushSync(true) before capturePictureReferenceRegion", async () => {
      const opts = defaultOptions();
      mockPreview.capturePictureReferenceRegion.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.onAddRegionPictureReference();
      });

      expect(opts.pushSync).toHaveBeenCalledWith(true);
      const pushOrder = opts.pushSync.mock.invocationCallOrder[0];
      const captureOrder = mockPreview.capturePictureReferenceRegion.mock.invocationCallOrder[0];
      expect(pushOrder).toBeLessThan(captureOrder);
    });

    it("enqueues the attachment on success", async () => {
      mockPreview.capturePictureReferenceRegion.mockResolvedValue(
        makeCapturePngResult({ meta: { id: "region-1", name: "region.png", mimeType: "image/png", sizeBytes: 5, sourcePath: "/tmp/region.png" } }),
      );

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddRegionPictureReference();
      });

      expect(mockEnqueue).toHaveBeenCalledOnce();
      const [calledThreadId] = mockEnqueue.mock.calls[0] as [string, unknown];
      expect(calledThreadId).toBe(THREAD_ID);
    });

    it("shows a toast on non-silent error", async () => {
      mockPreview.capturePictureReferenceRegion.mockResolvedValue({
        ok: false,
        error: "region-too-small",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddRegionPictureReference();
      });

      expect(mockShow).toHaveBeenCalledOnce();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("does NOT show a toast for silent error 'cancelled'", async () => {
      mockPreview.capturePictureReferenceRegion.mockResolvedValue({ ok: false, error: "cancelled" });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddRegionPictureReference();
      });

      expect(mockShow).not.toHaveBeenCalled();
    });

    it("resets regionBusy to false after completion", async () => {
      mockPreview.capturePictureReferenceRegion.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddRegionPictureReference();
      });

      expect(result.current.regionBusy).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // captureAnnotationSnapshot
  // -------------------------------------------------------------------------

  describe("captureAnnotationSnapshot", () => {
    const overlay = {
      activeDisplayNumber: 2,
      activeBounds: { x: 40, y: 50, width: 120, height: 32 },
      markers: [
        { displayNumber: 1, bounds: { x: 10, y: 12, width: 80, height: 24 } },
        { displayNumber: 2, bounds: { x: 40, y: 50, width: 120, height: 32 } },
      ],
    };

    const capture = {
      schemaVersion: 2 as const,
      pageUrl: "https://example.com",
      pageTitle: "Example",
      capturedAt: "2026-07-02T00:00:00.000Z",
      captureKind: "viewport" as const,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };

    it("calls pushSync(true) before captureAnnotationSnapshot", async () => {
      const opts = defaultOptions();
      mockPreview.captureAnnotationSnapshot.mockResolvedValue(
        makeCapturePngResult({ capture }),
      );

      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.captureAnnotationSnapshot(overlay);
      });

      expect(opts.pushSync).toHaveBeenCalledWith(true);
      expect(mockPreview.captureAnnotationSnapshot).toHaveBeenCalledWith(overlay);
      const pushOrder = opts.pushSync.mock.invocationCallOrder[0];
      const captureOrder = mockPreview.captureAnnotationSnapshot.mock.invocationCallOrder[0];
      expect(pushOrder).toBeLessThan(captureOrder);
    });

    it("returns snapshot metadata from the annotated capture result", async () => {
      mockPreview.captureAnnotationSnapshot.mockResolvedValue(
        makeCapturePngResult({ capture }),
      );

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));
      let snapshot: Awaited<ReturnType<typeof result.current.captureAnnotationSnapshot>> = null;

      await act(async () => {
        snapshot = await result.current.captureAnnotationSnapshot(overlay);
      });

      expect(snapshot).toEqual({
        id: "capture-id-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 3,
        sourcePath: "/tmp/capture.png",
        capture,
      });
    });
  });

  // -------------------------------------------------------------------------
  // onAddElementPickPictureReference
  // -------------------------------------------------------------------------

  describe("onAddElementPickPictureReference", () => {
    it("calls pushSync(true) before capturePictureReferenceElementPick", async () => {
      const opts = defaultOptions();
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(opts.pushSync).toHaveBeenCalledWith(true);
      const pushOrder = opts.pushSync.mock.invocationCallOrder[0];
      const captureOrder = mockPreview.capturePictureReferenceElementPick.mock.invocationCallOrder[0];
      expect(pushOrder).toBeLessThan(captureOrder);
    });

    it("enqueues the attachment on success", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(mockEnqueue).toHaveBeenCalledOnce();
    });

    it("shows a toast on non-silent error", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue({
        ok: false,
        error: "no-hit",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(mockShow).toHaveBeenCalledOnce();
    });

    it("does NOT show a toast for silent error 'cancelled'", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue({ ok: false, error: "cancelled" });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(mockShow).not.toHaveBeenCalled();
    });

    it("resets elementPickBusy to false after completion", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(result.current.elementPickBusy).toBe(false);
    });
  });

  describe("onAddElementAnnotation", () => {
    it("stores selected element style details on the draft", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(
        makeCapturePngResult({
          capture: {
            schemaVersion: 2,
            pageUrl: "https://example.com/products#details",
            pageTitle: "Products",
            capturedAt: "2026-07-01T00:00:00.000Z",
            captureKind: "element",
            selectorHint: "button.buy",
            bounds: { x: 10, y: 20, width: 120, height: 40 },
            elementStyle: {
              textColor: "rgb(255, 255, 255)",
              background: "rgb(10, 52, 92)",
              opacity: 0.75,
              font: "Inter, sans-serif",
              fontSize: "14px",
            },
          },
        }),
      );

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementAnnotation();
      });

      expect(usePreviewAnnotationStore.getState().drafts[THREAD_ID]).toMatchObject({
        pageIdentity: "https://example.com/products",
        selectorHint: "button.buy",
        elementStyle: {
          textColor: "rgb(255, 255, 255)",
          background: "rgb(10, 52, 92)",
          opacity: 0.75,
          font: "Inter, sans-serif",
          fontSize: "14px",
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // onAddPageContextOnly
  // -------------------------------------------------------------------------

  describe("onAddPageContextOnly", () => {
    it("calls pushSync(true) before capturePageContext", async () => {
      const opts = defaultOptions();
      mockPreview.capturePageContext.mockResolvedValue(makeContextResult());

      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.onAddPageContextOnly();
      });

      expect(opts.pushSync).toHaveBeenCalledWith(true);
      const pushOrder = opts.pushSync.mock.invocationCallOrder[0];
      const captureOrder = mockPreview.capturePageContext.mock.invocationCallOrder[0];
      expect(pushOrder).toBeLessThan(captureOrder);
    });

    it("enqueues a contextOnly attachment on success", async () => {
      mockPreview.capturePageContext.mockResolvedValue(makeContextResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPageContextOnly();
      });

      expect(mockEnqueue).toHaveBeenCalledOnce();
      const [calledThreadId, attachment] = mockEnqueue.mock.calls[0] as [string, Record<string, unknown>];
      expect(calledThreadId).toBe(THREAD_ID);
      expect(attachment.contextOnly).toBe(true);
      expect(attachment.mimeType).toBe(MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME);
      expect(attachment.name).toBe("Page context");
      expect(attachment.sizeBytes).toBe(0);
      expect(attachment.previewUrl).toBe("");
      expect(attachment.filePath).toBeNull();
    });

    it("assigns a UUID as attachment id", async () => {
      mockPreview.capturePageContext.mockResolvedValue(makeContextResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPageContextOnly();
      });

      const [, attachment] = mockEnqueue.mock.calls[0] as [string, Record<string, unknown>];
      // UUID pattern: 8-4-4-4-12 hex digits
      expect(typeof attachment.id).toBe("string");
      expect((attachment.id as string).length).toBeGreaterThan(0);
    });

    it("shows a toast on non-silent error", async () => {
      mockPreview.capturePageContext.mockResolvedValue({
        ok: false,
        error: "no-preview",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPageContextOnly();
      });

      expect(mockShow).toHaveBeenCalledOnce();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("does NOT show a toast for silent error 'cancelled'", async () => {
      mockPreview.capturePageContext.mockResolvedValue({ ok: false, error: "cancelled" });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPageContextOnly();
      });

      expect(mockShow).not.toHaveBeenCalled();
    });

    it("shows a toast and resets contextBusy when capturePageContext throws", async () => {
      mockPreview.capturePageContext.mockRejectedValue(new Error("IPC failure"));

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPageContextOnly();
      });

      expect(mockShow).toHaveBeenCalledWith("error", "Could not capture preview", "Context capture failed.");
      expect(result.current.contextBusy).toBe(false);
    });

    it("resets contextBusy to false after success", async () => {
      mockPreview.capturePageContext.mockResolvedValue(makeContextResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddPageContextOnly();
      });

      expect(result.current.contextBusy).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // anyCaptureActive composition
  // -------------------------------------------------------------------------

  describe("anyCaptureActive", () => {
    it("is true while capturePictureReference is in-flight", async () => {
      let resolveCapture!: (v: unknown) => void;
      mockPreview.capturePictureReference.mockReturnValue(
        new Promise((res) => {
          resolveCapture = res;
        }),
      );

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      // Start but do not await
      act(() => {
        void result.current.onAddPictureReference();
      });

      await waitFor(() => expect(result.current.captureBusy).toBe(true));
      expect(result.current.anyCaptureActive).toBe(true);

      // Let the capture settle
      await act(async () => {
        resolveCapture({ ok: false, error: "cancelled" });
      });

      expect(result.current.anyCaptureActive).toBe(false);
    });

    it("is true while capturePageContext is in-flight", async () => {
      let resolveCapture!: (v: unknown) => void;
      mockPreview.capturePageContext.mockReturnValue(
        new Promise((res) => {
          resolveCapture = res;
        }),
      );

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      act(() => {
        void result.current.onAddPageContextOnly();
      });

      await waitFor(() => expect(result.current.contextBusy).toBe(true));
      expect(result.current.anyCaptureActive).toBe(true);

      await act(async () => {
        resolveCapture({ ok: false, error: "cancelled" });
      });

      expect(result.current.anyCaptureActive).toBe(false);
    });
  });
});
