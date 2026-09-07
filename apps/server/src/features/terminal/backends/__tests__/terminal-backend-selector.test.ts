import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { LegacyTerminalBackend } from "../legacy/legacy-terminal-backend.js";
import type { TerminalService } from "../legacy/terminal-service.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { TerminalProfileService } from "../../profiles/terminal-profile-service.js";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { TerminalBackendSelector } from "../terminal-backend-selector.js";
import type { TerminalBackend } from "../terminal-backend.js";

describe("TerminalBackendSelector", () => {
  it("keeps one legacy backend selected for capability reporting and Terminal work", async () => {
    const create = vi.fn(async () => ({ ptyId: "pty-1", shell: "pwsh" }));
    const service = { create } as unknown as TerminalService;
    const threads = { findById: () => undefined } as unknown as ThreadRepo;
    const profiles = {
      resolveLaunchProfile: async () => ({
        requestedProfileId: "default",
        resolvedProfile: { executable: "pwsh", arguments: [] },
      }),
    } as unknown as TerminalProfileService;
    const legacyBackend = new LegacyTerminalBackend(service, threads, profiles, {} as HostRuntime);
    const selector = new TerminalBackendSelector(legacyBackend);

    const selected = selector.getSelectedBackend();

    expect(selected.capabilities()).toEqual({
      contractVersion: 0,
      backend: "legacy",
      publicFrameVersion: 0,
      recovery: { replay: true, checkpoint: true, gap: true },
    });
    await expect(selected.create("thread-1")).resolves.toEqual({ ptyId: "pty-1", shell: "pwsh" });
    expect(create).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      executable: "pwsh",
      requestedProfileId: "default",
    }));
    expect(selector.getSelectedBackend()).toBe(selected);
  });

  it("selects the modern backend only for the protected boot value", () => {
    const legacyBackend = new LegacyTerminalBackend({} as TerminalService, {} as never, {} as never, {} as HostRuntime);
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
