import { describe, expect, it, vi } from "vitest";
import { createProviderHostPorts } from "../provider-host-ports.js";

describe("createProviderHostPorts", () => {
  it("routes canonical drafts through the server-owned sink", async () => {
    const commit = vi.fn();
    const ports = createProviderHostPorts({
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
    } as never);
    const batch = {
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: "00000000-0000-4000-8000-000000000001",
      phase: "streaming",
      events: [],
    };

    await ports.events.submit(batch);

    expect(commit).toHaveBeenCalledWith({ ...batch, nativeCursor: undefined });
  });
});
