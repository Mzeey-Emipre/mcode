import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const setBackground = vi.fn().mockResolvedValue(undefined);
const applyConversationMemoryPressure = vi.fn();

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => ({ setBackground }),
  };
});

// threadStore.clearToolCallRecordCache is called during idle — stub the module
// so we don't pull in its ambient dependencies.
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: () => ({ clearToolCallRecordCache: vi.fn(), applyConversationMemoryPressure }),
  },
}));

import { useIdleReclamation } from "@/hooks/useIdleReclamation";

// Inlined literal: the hook previously dispatched this event to wipe xterm
// scrollback after 60s of blur. The symbol is gone from the module — this
// test asserts the dispatch is gone by name, not by import.
const LEGACY_CLEAR_EVENT = "mcode:clear-terminal-buffers";

describe("useIdleReclamation (regression #305)", () => {
  beforeEach(() => {
    setBackground.mockClear();
    applyConversationMemoryPressure.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Previously, after 60s of background idle the hook dispatched
  // LEGACY_CLEAR_EVENT, which wiped xterm scrollback. Users reported
  // their terminal content vanishing after leaving the app for a minute —
  // that's the bug. Server-side idle reclamation still runs; only the
  // destructive frontend buffer wipe must be gone.
  it("does not dispatch LEGACY_CLEAR_EVENT on background idle", () => {
    const listener = vi.fn();
    window.addEventListener(LEGACY_CLEAR_EVENT, listener);

    renderHook(() => useIdleReclamation());

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(61_000);

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(LEGACY_CLEAR_EVENT, listener);
  });

  it("still notifies the server to enter background idle", () => {
    renderHook(() => useIdleReclamation());

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(61_000);

    expect(setBackground).toHaveBeenCalledWith(true);
  });

  it("applies warning pressure to conversation residency during background idle", () => {
    renderHook(() => useIdleReclamation());

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(61_000);

    expect(applyConversationMemoryPressure).toHaveBeenCalledWith("warning");
  });
});
