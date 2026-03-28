import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ShikiTheme } from "../hooks/useTheme";

// Mock the Worker since jsdom doesn't support real Workers
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn(() => false);
  onerror = null;
  onmessageerror = null;
}

let mockWorkerInstance: MockWorker;
let useHighlighter: typeof import("../hooks/useHighlighter")["useHighlighter"];

beforeEach(async () => {
  mockWorkerInstance = new MockWorker();
  vi.stubGlobal("Worker", class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage: typeof MockWorker.prototype.postMessage;
    terminate: typeof MockWorker.prototype.terminate;
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispatchEvent = vi.fn(() => false);
    onerror = null;
    onmessageerror = null;

    constructor() {
      mockWorkerInstance = this as unknown as MockWorker;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
    }
  });

  // Fresh module import so each test gets its own singleton state
  vi.resetModules();
  const mod = await import("../hooks/useHighlighter");
  useHighlighter = mod.useHighlighter;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useHighlighter", () => {
  it("returns null html initially", () => {
    const { result } = renderHook(() =>
      useHighlighter("const x = 1;", "typescript", "github-dark"),
    );
    expect(result.current.html).toBeNull();
  });

  it("posts a message to the worker with code, language, and theme", () => {
    renderHook(() =>
      useHighlighter("const x = 1;", "typescript", "github-dark"),
    );
    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "const x = 1;",
        language: "typescript",
        theme: "github-dark",
      }),
    );
  });

  it("returns highlighted html when worker responds", async () => {
    const { result } = renderHook(() =>
      useHighlighter("const x = 1;", "typescript", "github-dark"),
    );

    const sentId = mockWorkerInstance.postMessage.mock.calls[0][0].id;

    act(() => {
      mockWorkerInstance.onmessage?.(
        new MessageEvent("message", {
          data: { id: sentId, html: '<pre class="shiki">highlighted</pre>' },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.html).toBe('<pre class="shiki">highlighted</pre>');
    });
  });

  it("re-requests when code changes", () => {
    const { rerender } = renderHook(
      ({ code }) => useHighlighter(code, "typescript", "github-dark"),
      { initialProps: { code: "const x = 1;" } },
    );

    rerender({ code: "const y = 2;" });

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledTimes(2);
    expect(mockWorkerInstance.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "const y = 2;" }),
    );
  });

  it("re-requests when theme changes", () => {
    const { rerender } = renderHook(
      ({ theme }) => useHighlighter("const x = 1;", "typescript", theme),
      { initialProps: { theme: "github-dark" as ShikiTheme } },
    );

    rerender({ theme: "github-light" });

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledTimes(2);
    expect(mockWorkerInstance.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "github-light" }),
    );
  });

  it("does not post to the worker when enabled is false", () => {
    const { result } = renderHook(() =>
      useHighlighter("const x = 1;", "typescript", "github-dark", false),
    );
    expect(mockWorkerInstance.postMessage).not.toHaveBeenCalled();
    expect(result.current.html).toBeNull();
  });

  it("posts to the worker when enabled switches from false to true", () => {
    const { rerender } = renderHook(
      ({ enabled }) => useHighlighter("const x = 1;", "typescript", "github-dark", enabled),
      { initialProps: { enabled: false } },
    );

    expect(mockWorkerInstance.postMessage).not.toHaveBeenCalled();

    rerender({ enabled: true });

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledTimes(1);
    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ code: "const x = 1;" }),
    );
  });
});
