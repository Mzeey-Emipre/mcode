import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  killProcessTree: vi.fn(),
  scope: {
    assign: vi.fn(),
    reconcile: vi.fn(),
    queryProcessIds: vi.fn(),
    terminate: vi.fn(),
    waitForEmpty: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("../../../../runtime/process/containment/process-kill.js", () => ({
  gracefulKillProcessTree: vi.fn(),
  killProcessTree: mocks.killProcessTree,
  listDirectChildren: vi.fn(),
}));

vi.mock("../../../../runtime/process/containment/windows-process-scope.js", () => ({
  WindowsProcessScopeFactory: class {
    create() {
      return mocks.scope;
    }
  },
}));

import { createPtyProcessScope } from "../pty-process-scope.js";

describe("createPtyProcessScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.assign.mockReturnValue({ ok: true });
    mocks.scope.reconcile.mockResolvedValue({
      ok: false,
      error: "snapshot unavailable",
    });
    mocks.scope.terminate.mockReturnValue({ ok: true });
    mocks.scope.waitForEmpty.mockResolvedValue({ ok: true });
  });

  it.runIf(process.platform === "win32")(
    "terminates and waits for the Job Object when fallback cleanup fails",
    async () => {
      const fallbackError = new Error("fallback cleanup failed");
      mocks.killProcessTree.mockRejectedValue(fallbackError);
      const scope = createPtyProcessScope(123);

      await expect(scope.close()).rejects.toBe(fallbackError);

      expect(mocks.scope.terminate).toHaveBeenCalledWith(0);
      expect(mocks.scope.waitForEmpty).toHaveBeenCalledWith(5_000);
    },
  );
});
