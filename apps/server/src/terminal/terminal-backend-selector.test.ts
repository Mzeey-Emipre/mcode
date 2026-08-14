import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { LegacyTerminalBackend } from "./legacy/legacy-terminal-backend.js";
import type { TerminalService } from "./legacy/terminal-service.js";
import { TerminalBackendSelector } from "./terminal-backend-selector.js";
import type { TerminalBackend } from "./terminal-backend.js";

describe("TerminalBackendSelector", () => {
  it("keeps one legacy backend selected for capability reporting and Terminal work", () => {
    const create = vi.fn(() => ({ ptyId: "pty-1", shell: "pwsh" }));
    const service = { create } as unknown as TerminalService;
    const legacyBackend = new LegacyTerminalBackend(service);
    const selector = new TerminalBackendSelector(legacyBackend);

    const selected = selector.getSelectedBackend();

    expect(selected.capabilities()).toEqual({
      contractVersion: 0,
      backend: "legacy",
      publicFrameVersion: 0,
      recovery: { replay: true, checkpoint: true, gap: true },
    });
    expect(selected.create("thread-1")).toEqual({ ptyId: "pty-1", shell: "pwsh" });
    expect(create).toHaveBeenCalledWith("thread-1");
    expect(selector.getSelectedBackend()).toBe(selected);
    expect(selector.capabilities()).not.toHaveProperty("releaseTest");
  });

  it("selects the modern backend only for the protected boot value", () => {
    const legacyBackend = new LegacyTerminalBackend({} as TerminalService);
    const modernBackend = { capabilities: vi.fn() } as unknown as TerminalBackend;

    expect(
      new TerminalBackendSelector(legacyBackend, modernBackend, {
        MCODE_TERMINAL_RELEASE_TEST: "1",
        MCODE_TERMINAL_BACKEND: "modern",
      }).getSelectedBackend(),
    ).toBe(modernBackend);
    expect(
      new TerminalBackendSelector(legacyBackend, modernBackend, {
        MCODE_TERMINAL_BACKEND: "MODERN",
      }).getSelectedBackend(),
    ).toBe(legacyBackend);
    expect(
      new TerminalBackendSelector(legacyBackend, modernBackend, {
        MCODE_TERMINAL_BACKEND: "modern",
      }).getSelectedBackend(),
    ).toBe(modernBackend);
  });

  it("falls back to legacy when the modern startup health check fails", async () => {
    const legacyBackend = new LegacyTerminalBackend({} as TerminalService);
    const modernBackend = {
      capabilities: vi.fn(() => ({
        contractVersion: 1,
        backend: "modern",
        releaseTest: { hostPid: 77 },
      })),
      whenStarted: vi.fn(async () => {
        throw new Error("host did not become healthy");
      }),
      shutdown: vi.fn(async () => undefined),
    } as unknown as TerminalBackend;
    const selector = new TerminalBackendSelector(legacyBackend, modernBackend, {
      MCODE_TERMINAL_RELEASE_TEST: "1",
      MCODE_TERMINAL_BACKEND: "modern",
    });

    await selector.waitForStartup();

    expect(selector.getSelectedBackend()).toBe(legacyBackend);
    expect(selector.capabilities()).toMatchObject({
      contractVersion: 0,
      backend: "legacy",
      releaseTest: { hostPid: 77 },
    });
  });

  it("keeps protected development startup failures visible", async () => {
    const legacyBackend = new LegacyTerminalBackend({} as TerminalService);
    const modernBackend = {
      capabilities: vi.fn(() => ({
        contractVersion: 1,
        backend: "modern",
        releaseTest: { hostPid: 78 },
      })),
      whenStarted: vi.fn(async () => {
        throw new Error("host did not become healthy");
      }),
    } as unknown as TerminalBackend;
    const selector = new TerminalBackendSelector(legacyBackend, modernBackend, {
      MCODE_TERMINAL_BACKEND: "modern",
    });

    await expect(selector.waitForStartup()).rejects.toThrow("host did not become healthy");
    expect(selector.getSelectedBackend()).toBe(modernBackend);
  });

  it("shuts down the unselected modern backend exactly once after release fallback", async () => {
    const legacyBackend = new LegacyTerminalBackend({} as TerminalService);
    const legacyShutdown = vi.spyOn(legacyBackend, "shutdown").mockResolvedValue(undefined);
    let resolveModernShutdown!: () => void;
    const modernShutdown = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveModernShutdown = resolve;
      }),
    );
    const modernBackend = {
      capabilities: vi.fn(),
      whenStarted: vi.fn(async () => {
        throw new Error("host did not become healthy");
      }),
      shutdown: modernShutdown,
    } as unknown as TerminalBackend;
    const selector = new TerminalBackendSelector(legacyBackend, modernBackend, {
      MCODE_TERMINAL_RELEASE_TEST: "1",
      MCODE_TERMINAL_BACKEND: "modern",
    });

    await selector.waitForStartup();
    expect(modernShutdown).toHaveBeenCalledOnce();
    const shutdown = selector.shutdown();
    expect(legacyShutdown).not.toHaveBeenCalled();
    resolveModernShutdown();
    await shutdown;
    await selector.shutdown();
    expect(modernShutdown).toHaveBeenCalledOnce();
    expect(legacyShutdown).toHaveBeenCalledOnce();
  });

  it("keeps modern selected after a healthy startup", async () => {
    const legacyBackend = new LegacyTerminalBackend({} as TerminalService);
    const modernBackend = {
      capabilities: vi.fn(() => ({ backend: "modern" })),
      whenStarted: vi.fn(async () => undefined),
    } as unknown as TerminalBackend;
    const selector = new TerminalBackendSelector(legacyBackend, modernBackend, {
      MCODE_TERMINAL_RELEASE_TEST: "1",
      MCODE_TERMINAL_BACKEND: "modern",
    });

    await selector.waitForStartup();

    expect(selector.getSelectedBackend()).toBe(modernBackend);
  });
});
