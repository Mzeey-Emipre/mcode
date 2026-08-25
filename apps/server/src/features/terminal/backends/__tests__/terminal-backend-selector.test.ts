import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { LegacyTerminalBackend } from "../legacy/legacy-terminal-backend.js";
import type { TerminalService } from "../legacy/terminal-service.js";
import { TerminalBackendSelector } from "../terminal-backend-selector.js";
import type { TerminalBackend } from "../terminal-backend.js";

describe("TerminalBackendSelector", () => {
  it("keeps one legacy backend selected for capability reporting and Terminal work", () => {
    const create = vi.fn(() => ({ ptyId: "pty-1", shell: "pwsh" }));
    const service = { create } as unknown as TerminalService;
    const legacyBackend = new LegacyTerminalBackend(service, {} as never, {} as never);
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
  });

  it("selects the modern backend only for the protected boot value", () => {
    const legacyBackend = new LegacyTerminalBackend({} as TerminalService, {} as never, {} as never);
    const modernBackend = { capabilities: vi.fn() } as unknown as TerminalBackend;

    expect(
      new TerminalBackendSelector(legacyBackend, modernBackend, {
        MCODE_TERMINAL_BACKEND: "modern",
      }).getSelectedBackend(),
    ).toBe(modernBackend);
    expect(
      new TerminalBackendSelector(legacyBackend, modernBackend, {
        MCODE_TERMINAL_BACKEND: "MODERN",
      }).getSelectedBackend(),
    ).toBe(legacyBackend);
  });
});
