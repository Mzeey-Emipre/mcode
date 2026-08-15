import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerInfo } = vi.hoisted(() => ({ loggerInfo: vi.fn() }));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue("C:/mcode-test"),
    setPath: vi.fn(),
    getAppPath: vi.fn().mockReturnValue("C:/mcode-test"),
    getName: vi.fn().mockReturnValue("Mcode"),
    getVersion: vi.fn().mockReturnValue("0.0.0-test"),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    on: vi.fn(),
    exit: vi.fn(),
    quit: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    getGPUFeatureStatus: vi.fn().mockReturnValue({ gpu_compositing: "disabled_software" }),
    getAppMetrics: vi.fn().mockReturnValue([
      {
        pid: 42,
        creationTime: 1_786_536_000_000,
        type: "Renderer",
        cpu: { percentCPUUsage: 3.5 },
        memory: {
          workingSetSize: 100,
          peakWorkingSetSize: 120,
          privateBytes: 80,
        },
      },
    ]),
    commandLine: { appendSwitch: vi.fn() },
    setAppUserModelId: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn().mockReturnValue([]),
  },
  clipboard: {},
  dialog: { showErrorBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  Notification: { isSupported: vi.fn().mockReturnValue(false) },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn() },
  protocol: { handle: vi.fn() },
  session: { defaultSession: { cookies: { set: vi.fn() } } },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock("@mcode/shared", () => ({
  getLogPath: vi.fn(),
  getMcodeDir: vi.fn().mockReturnValue("C:/mcode-test"),
  getRecentLogs: vi.fn(),
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@mcode/contracts", () => ({
  getExtension: vi.fn().mockReturnValue(""),
  isMcodeWorkspacePreviewUrl: vi.fn().mockReturnValue(false),
  SettingsSchema: vi.fn(() => ({
    safeParse: vi.fn(() => ({ success: false })),
  })),
}));

vi.mock("../open-in/index.js", () => ({ openInRegistry: vi.fn() }));
vi.mock("../../features/server-runtime/index.js", () => ({
  ServerRuntime: class {
    start = vi.fn();
    registerLifecycle = vi.fn();
    registerConnectionHandlers = vi.fn();
    installAuthCookie = vi.fn();
    attachWindow = vi.fn();
    forceReplace = vi.fn();
    get port() {
      return 0;
    }
  },
}));
vi.mock("../../features/application-updates/index.js", () => ({
  initializeApplicationUpdates: vi.fn(),
  cleanupApplicationUpdates: vi.fn(),
}));
vi.mock("../spellcheck.js", () => ({ setupSpellcheck: vi.fn() }));
vi.mock("../../features/preview/index.js", () => ({
  registerPreviewBrowserHandlers: vi.fn(),
  disposeBrowserAutomationForWindow: vi.fn(),
  disposePreviewForWindow: vi.fn(),
  resolveMcodeWorkspacePreviewUrl: vi.fn(),
  hardenPreviewWebviewAttachment: vi.fn(),
  resolvePreviewGuestPreloadPath: vi.fn(),
}));
vi.mock("../is-desktop-dev.js", () => ({ isDesktopDev: vi.fn().mockReturnValue(false) }));
vi.mock("../cli-args.js", () => ({ shouldPrintVersion: vi.fn().mockReturnValue(false) }));

import {
  getFrontendPerformanceMetrics,
  handleRendererCrashReport,
  normalizeRendererCrashReport,
  resolveHardwareAccelerationMode,
} from "../main.js";

describe("renderer crash report IPC boundary", () => {
  beforeEach(() => {
    loggerInfo.mockClear();
  });

  it("drops reports from unauthorized senders", () => {
    const authorized = { id: 101 };
    handleRendererCrashReport(
      { sender: { id: 1 } },
      { errorName: "Error", componentStack: "\n    at App (https://example.test/App.tsx:1:1)" },
      authorized,
    );

    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("drops malformed and extra-field payloads", () => {
    const authorized = { id: 102 };
    const event = { sender: authorized };
    handleRendererCrashReport(event, null, authorized);
    handleRendererCrashReport(
      event,
      { errorName: "Error", componentStack: "\n    at App", extra: true },
      authorized,
    );

    expect(loggerInfo).not.toHaveBeenCalled();
    expect(
      normalizeRendererCrashReport({ errorName: "Error", componentStack: "not a React stack" }),
    ).toBeNull();
  });

  it("logs only bounded frame names, never renderer locations or free-form text", () => {
    const authorized = { id: 103 };
    handleRendererCrashReport(
      { sender: authorized },
      {
        errorName: "TypeError",
        componentStack: [
          "",
          "    at App (https://example.test/src/App.tsx:10:4)",
          "    at Button props=secret state=token (file:///C:/repo/Button.tsx:2:1)",
          "    at div (C:\\repo\\index.tsx:1:1)",
        ].join("\n"),
      },
      authorized,
    );

    expect(loggerInfo).toHaveBeenCalledWith("Renderer crash report", {
      errorName: "TypeError",
      componentStack: "App\ndiv",
      componentStackTruncated: false,
    });
    const serialized = JSON.stringify(loggerInfo.mock.calls[0]);
    expect(serialized).not.toMatch(/https?:|file:|C:\\\\|props|state|src\/|\.tsx/);
  });

  it("returns only safe structured fields for valid frames", () => {
    expect(
      normalizeRendererCrashReport({
        errorName: "UnknownError",
        componentStack: "\n    at App\n    at ForwardRef.Button (https://host/path:1:1)",
      }),
    ).toEqual({
      errorName: "Error",
      componentStack: "App\nForwardRef.Button",
      componentStackTruncated: false,
    });
  });

  it("bounds frame count and marks dropped safe frames", () => {
    const stack = Array.from({ length: 40 }, (_, index) => `    at Component${index}`).join("\n");
    const normalized = normalizeRendererCrashReport({ errorName: "Error", componentStack: stack });

    expect(normalized?.componentStack.split("\n")).toHaveLength(32);
    expect(normalized?.componentStackTruncated).toBe(true);
  });

  it("rate-limits reports per sender within the sliding window", () => {
    vi.useFakeTimers();
    try {
      const authorized = { id: 104 };
      const event = { sender: authorized };
      const payload = { errorName: "Error", componentStack: "\n    at App" };
      for (let index = 0; index < 4; index += 1) {
        handleRendererCrashReport(event, payload, authorized);
      }
      expect(loggerInfo).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(60_001);
      handleRendererCrashReport(event, payload, authorized);
      expect(loggerInfo).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("frontend performance metrics", () => {
  it("changes acceleration only for an explicit production performance run", () => {
    expect(resolveHardwareAccelerationMode({})).toBe("disabled");
    expect(resolveHardwareAccelerationMode({
      MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE: "default",
    })).toBe("disabled");
    expect(resolveHardwareAccelerationMode({
      MCODE_FRONTEND_PERFORMANCE_MODE: "production",
      MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE: "disabled",
    })).toBe("disabled");
    expect(resolveHardwareAccelerationMode({
      MCODE_FRONTEND_PERFORMANCE_MODE: "production",
      MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE: "default",
    })).toBe("default");
    expect(() => resolveHardwareAccelerationMode({
      MCODE_FRONTEND_PERFORMANCE_MODE: "production",
      MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE: "invalid",
    })).toThrow(/disabled or default/);
  });

  it("keeps process CPU, memory, and hardware state separate", () => {
    expect(getFrontendPerformanceMetrics()).toEqual({
      packaged: false,
      accelerationMode: "disabled",
      gpuFeatureStatus: { gpu_compositing: "disabled_software" },
      devToolsOpen: false,
      processes: [
        {
          pid: 42,
          creationTime: 1_786_536_000_000,
          type: "Renderer",
          cpuPercent: 3.5,
          memory: {
            workingSetSizeKiB: 100,
            peakWorkingSetSizeKiB: 120,
            privateBytesKiB: 80,
          },
        },
      ],
    });
  });
});
