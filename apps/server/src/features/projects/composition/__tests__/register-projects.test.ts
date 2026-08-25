import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { TERMINAL_BACKEND_TOKEN, type TerminalBackend } from "../../../terminal/backends/terminal-backend.js";
import { TerminalCommandService } from "../../../terminal/commands/terminal-command-service.js";
import { ProjectActionService } from "../../environment/project-action-service.js";
import { WorkspaceEnvironmentService } from "../../environment/workspace-environment-service.js";
import { registerProjectServices } from "../register-projects.js";

describe("registerProjectServices", () => {
  it("registers one stateful workspace environment lifecycle service", () => {
    const projectContainer = container.createChildContainer();
    projectContainer.register(ThreadRepo, { useValue: {} as ThreadRepo });
    projectContainer.register(TerminalCommandService, { useValue: {} as TerminalCommandService });

    registerProjectServices(projectContainer);

    expect(projectContainer.resolve(WorkspaceEnvironmentService)).toBe(
      projectContainer.resolve(WorkspaceEnvironmentService),
    );
  });

  it("resolves Project Actions with production clock and run-ID registrations", () => {
    const projectContainer = container.createChildContainer();
    projectContainer.register(ThreadRepo, { useValue: {} as ThreadRepo });
    projectContainer.register("ThreadRepo", { useFactory: (c) => c.resolve(ThreadRepo) });
    projectContainer.register(TerminalCommandService, { useValue: {} as TerminalCommandService });
    projectContainer.register(TERMINAL_BACKEND_TOKEN, { useValue: {} as TerminalBackend });
    projectContainer.register("Database", { useValue: {} });

    registerProjectServices(projectContainer);

    expect(projectContainer.resolve(ProjectActionService)).toBeInstanceOf(ProjectActionService);
  });
});
