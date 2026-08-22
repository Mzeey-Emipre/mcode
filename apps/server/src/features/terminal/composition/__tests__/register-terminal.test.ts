import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import { GitService } from "../../../projects/git/git-service.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { TerminalCommandService } from "../../commands/terminal-command-service.js";
import { TerminalProfileService } from "../../profiles/terminal-profile-service.js";
import { registerTerminalBackends } from "../register-terminal.js";

describe("registerTerminalBackends", () => {
  it("registers one Terminal command service through the container", () => {
    const terminalContainer = container.createChildContainer();
    terminalContainer.register(TerminalProfileService, { useValue: {} as TerminalProfileService });
    terminalContainer.register(EnvService, { useValue: {} as EnvService });
    terminalContainer.register(SettingsService, { useValue: {} as SettingsService });
    terminalContainer.register(WorkspaceRepo, { useValue: {} as WorkspaceRepo });
    terminalContainer.register(ThreadRepo, { useValue: {} as ThreadRepo });
    terminalContainer.register(GitService, { useValue: {} as GitService });

    registerTerminalBackends(terminalContainer);

    expect(terminalContainer.resolve(TerminalCommandService)).toBe(
      terminalContainer.resolve(TerminalCommandService),
    );
  });
});
