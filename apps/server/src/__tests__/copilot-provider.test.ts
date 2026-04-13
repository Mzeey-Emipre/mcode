import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks (hoisted to avoid TDZ issues with vi.mock) ---

const { mockExecFile, mockClient, MockCopilotClient } = vi.hoisted(() => {
  const mockClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue("connected"),
    listModels: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
  };
  // Must use a regular function (not arrow) so it can be called with `new`.
  // Returning an object from a constructor makes `new` use that object.
  const MockCopilotClient = vi.fn(function (this: unknown) {
    return mockClient;
  });
  return { mockExecFile: vi.fn(), mockClient, MockCopilotClient };
});

vi.mock("which", () => ({ default: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return { ...original, execFile: mockExecFile };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: MockCopilotClient,
  approveAll: vi.fn(),
}));

import which from "which";
import { CopilotProvider } from "../providers/copilot/copilot-provider.js";

/** Minimal SettingsService stub. */
function makeSettingsService(cliPath = "") {
  return {
    get: vi.fn().mockResolvedValue({
      provider: { cli: { copilot: cliPath } },
    }),
  };
}

describe("CopilotProvider bootstrap", () => {
  let origElectron: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    origElectron = process.versions.electron;
    mockClient.getState.mockReturnValue("disconnected");
    mockClient.start.mockResolvedValue(undefined);
    mockClient.listModels.mockResolvedValue([]);
    // Default: gh auth token succeeds.
    // Our mockExecFile doesn't have util.promisify.custom, so standard promisify
    // resolves with the first success callback arg. Pass { stdout } as that arg
    // so the provider's `const { stdout } = await execFileAsync(...)` works.
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, { stdout: "gho_faketoken\n" });
      },
    );
  });

  afterEach(() => {
    Object.defineProperty(process.versions, "electron", {
      value: origElectron,
      configurable: true,
    });
  });

  describe("Electron executor override", () => {
    it("calls which('node') and overrides process.execPath when in Electron", async () => {
      Object.defineProperty(process.versions, "electron", {
        value: "28.0.0",
        configurable: true,
      });
      (which as unknown as Mock).mockResolvedValue("/usr/bin/node");

      const provider = new CopilotProvider(makeSettingsService() as any);
      await provider.listModels();

      // which was called to find the real node binary
      expect(which).toHaveBeenCalledWith("node", { nothrow: true });
      // SDK client was constructed (override happened before construction)
      const ctorCall = MockCopilotClient.mock.calls[0]?.[0];
      expect(ctorCall).toBeDefined();
    });

    it("skips executor override when not in Electron", async () => {
      Object.defineProperty(process.versions, "electron", {
        value: undefined,
        configurable: true,
      });

      const provider = new CopilotProvider(makeSettingsService() as any);
      await provider.listModels();

      // which should not be called when not in Electron
      expect(which).not.toHaveBeenCalled();
      const ctorCall = MockCopilotClient.mock.calls[0]?.[0] ?? {};
      expect(ctorCall.cliPath).toBeUndefined();
    });
  });

  describe("gh auth token", () => {
    it("passes githubToken when gh auth succeeds", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: Function) => {
          cb(null, { stdout: "gho_abc123\n" });
        },
      );

      const provider = new CopilotProvider(makeSettingsService() as any);
      await provider.listModels();

      const opts = MockCopilotClient.mock.calls[0]?.[0];
      expect(opts?.githubToken).toBe("gho_abc123");
    });

    it("omits githubToken when gh is not installed", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: Function) => {
          cb(new Error("ENOENT"));
        },
      );

      const provider = new CopilotProvider(makeSettingsService() as any);
      await provider.listModels();

      const opts = MockCopilotClient.mock.calls[0]?.[0] ?? {};
      expect(opts.githubToken).toBeUndefined();
    });
  });

  describe("client reuse", () => {
    it("reuses healthy connected client", async () => {
      const provider = new CopilotProvider(makeSettingsService() as any);

      await provider.listModels();
      mockClient.getState.mockReturnValue("connected");
      await provider.listModels();

      // CopilotClient constructor called only once
      expect(MockCopilotClient.mock.calls).toHaveLength(1);
    });
  });

  describe("error translation", () => {
    it("translates CLI server exited to auth instructions", async () => {
      mockClient.start.mockResolvedValue(undefined);
      mockClient.getState.mockReturnValue("connected");
      mockClient.createSession.mockRejectedValue(
        new Error("CLI server exited with code 1"),
      );

      const provider = new CopilotProvider(makeSettingsService() as any);

      const events: any[] = [];
      provider.on("event", (e: any) => events.push(e));

      await provider.sendMessage({
        sessionId: "mcode-test1",
        message: "hello",
        cwd: "/tmp",
        model: "gpt-4o",
        resume: false,
        permissionMode: "auto",
      });

      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeDefined();
      expect(errorEvt.error).toContain("gh auth login");
    });

    it("translates package not found to install instructions", async () => {
      mockClient.start.mockResolvedValue(undefined);
      mockClient.getState.mockReturnValue("connected");
      mockClient.createSession.mockRejectedValue(
        new Error("Could not find @github/copilot"),
      );

      const provider = new CopilotProvider(makeSettingsService() as any);

      const events: any[] = [];
      provider.on("event", (e: any) => events.push(e));

      await provider.sendMessage({
        sessionId: "mcode-test2",
        message: "hello",
        cwd: "/tmp",
        model: "gpt-4o",
        resume: false,
        permissionMode: "auto",
      });

      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeDefined();
      expect(errorEvt.error).toContain("npm install");
    });
  });
});
