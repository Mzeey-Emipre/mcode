import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { TerminalCommandService } from "../../commands/terminal-command-service.js";
import { PtyPidRegistry } from "../../host/pty-pid-registry.js";
import { TerminalProfileService } from "../../profiles/terminal-profile-service.js";
import { registerTerminalBackends } from "../register-terminal.js";

describe("registerTerminalBackends", () => {
  it("registers one Terminal command service through the container", () => {
    const terminalContainer = container.createChildContainer();
    const pidRegistryDir = mkdtempSync(join(tmpdir(), "mcode-terminal-composition-"));
    terminalContainer.register(TerminalProfileService, { useValue: {} as TerminalProfileService });
    terminalContainer.register(EnvService, { useValue: {} as EnvService });
    terminalContainer.register(SettingsService, { useValue: {} as SettingsService });
    terminalContainer.register(WorkspaceRepo, { useValue: {} as WorkspaceRepo });
    terminalContainer.register(ThreadRepo, { useValue: {} as ThreadRepo });
    terminalContainer.register(GitWorktreeService, { useValue: {} as GitWorktreeService });
    terminalContainer.register("PtyPidRegistry", { useValue: new PtyPidRegistry(pidRegistryDir) });

    try {
      registerTerminalBackends(terminalContainer);

      expect(terminalContainer.resolve(TerminalCommandService)).toBe(
        terminalContainer.resolve(TerminalCommandService),
      );
    } finally {
      rmSync(pidRegistryDir, { recursive: true, force: true });
    }
  });
});
