import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

describe("shiki worker client performance boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_MCODE_PERFORMANCE_MODE", "production");
    vi.stubGlobal("Worker", MockWorker);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses midpoint handshake math and fails closed before synchronization", async () => {
    const {
      calculateWorkerClockOffset,
      workerDeliveryDuration,
    } = await import("../shiki-worker-client");
    expect(calculateWorkerClockOffset(100, 120, 109)).toBe(1);
    expect(calculateWorkerClockOffset(120, 100, 109)).toBeNull();
    expect(workerDeliveryDuration(1_000_000.25, 1_000_000.1)).toBeNull();
  });

  it("resolves and clears pending requests before a performance reset", async () => {
    const client = await import("../shiki-worker-client");
    const worker = client.getWorker() as unknown as MockWorker;
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "clock-sync" }),
    );
    const resolve = vi.fn();
    client.pending.set("pending-highlight", resolve);

    client.resetWorkerForPerformance();

    expect(resolve).toHaveBeenCalledWith(null);
    expect(client.pending.size).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
