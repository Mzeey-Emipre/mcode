import { TERMINAL_MAX_SESSIONS } from "@mcode/contracts";
import { Lifecycle, type DependencyContainer } from "tsyringe";

import { GitService } from "../../projects/git/git-service.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { SettingsService } from "../../settings/settings-service.js";
import { EnvService } from "../../../runtime/environment/env-service.js";
import { PtyHostCleanupLedger } from "../cleanup/terminal-cleanup-ledger.js";
import { PtyHostSupervisor } from "../host/pty-host-supervisor.js";
import { PtyPidRegistry } from "../host/pty-pid-registry.js";
import { resolvePtyHostEntryPath, spawnPtyHostChild } from "../host/pty-host-child.js";
import { TerminalBackend, TERMINAL_BACKEND_TOKEN } from "../backends/terminal-backend.js";
import { TerminalBackendSelector } from "../backends/terminal-backend-selector.js";
import { LegacyTerminalBackend } from "../backends/legacy/legacy-terminal-backend.js";
import { TerminalService as LegacyTerminalService } from "../backends/legacy/terminal-service.js";
import { ModernTerminalBackend } from "../backends/modern/modern-terminal-backend.js";
import { ModernTerminalSessionRuntime } from "../sessions/terminal-session-runtime.js";
import { TerminalSessionService } from "../sessions/terminal-session-service.js";
import { TerminalCommandService } from "../commands/terminal-command-service.js";
import { TerminalDiagnosticsService } from "../diagnostics/terminal-diagnostics-service.js";
import { TerminalProfileService } from "../profiles/terminal-profile-service.js";
import { WorkspaceTerminalPreferencesService } from "../preferences/workspace-terminal-preferences-service.js";

/** Register terminal backends, selector state, and backend diagnostics. */
export function registerTerminalBackends(container: DependencyContainer): void {
  let terminalCommandService: TerminalCommandService | undefined;
  container.register(TerminalCommandService, {
    useFactory: (c) => {
      if (terminalCommandService) return terminalCommandService;
      terminalCommandService = new TerminalCommandService({
        profiles: c.resolve(TerminalProfileService),
        env: c.resolve(EnvService),
        settings: c.resolve(SettingsService),
        workspaces: c.resolve(WorkspaceRepo),
        threads: c.resolve(ThreadRepo),
        pidRegistry: c.resolve<PtyPidRegistry>("PtyPidRegistry"),
        resolveWorkingDir: (workspacePath, mode, worktreePath) =>
          c.resolve(GitService).resolveWorkingDir(workspacePath, mode, worktreePath),
      });
      return terminalCommandService;
    },
  });
  container.register(
    LegacyTerminalService,
    { useClass: LegacyTerminalService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    LegacyTerminalBackend,
    { useClass: LegacyTerminalBackend },
    { lifecycle: Lifecycle.Singleton },
  );

  let modernTerminalBackend: ModernTerminalBackend | undefined;
  let terminalBackendSelector: TerminalBackendSelector | undefined;
  container.register("ModernTerminalBackend", {
    useFactory: (c: DependencyContainer) => {
      if (modernTerminalBackend) return modernTerminalBackend;
      const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
      const host = new PtyHostSupervisor({
        platform,
        cleanupLedger: c.resolve(PtyHostCleanupLedger),
        spawnHost: () => spawnPtyHostChild({
          entryPath: resolvePtyHostEntryPath(process.argv[1] ?? process.cwd()),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }),
      });
      const runtime = new ModernTerminalSessionRuntime({ host });
      const settings = c.resolve(SettingsService);
      const sessions = new TerminalSessionService({
        runtime,
        profiles: c.resolve(TerminalProfileService),
        settings,
        liveSettings: { apply: (next) => runtime.applySettings(next) },
        env: c.resolve(EnvService),
        workspaces: c.resolve(WorkspaceRepo),
        threads: c.resolve(ThreadRepo),
        resolveWorkingDir: (workspacePath, mode, worktreePath) =>
          c.resolve(GitService).resolveWorkingDir(workspacePath, mode, worktreePath),
        hostGeneration: () => host.health().hostGeneration,
      });
      modernTerminalBackend = new ModernTerminalBackend(
        sessions,
        runtime,
        host,
        () => settings.get().terminal.behavior.sessionLimit,
        undefined,
        (threadId) => c.resolve(ThreadRepo).findById(threadId)?.workspace_id ?? null,
      );
      return modernTerminalBackend;
    },
  } as never);
  container.register(
    "TerminalBackendSelector",
    {
      useFactory: (c: DependencyContainer) => {
        if (terminalBackendSelector) return terminalBackendSelector;
        terminalBackendSelector = new TerminalBackendSelector(
          c.resolve(LegacyTerminalBackend),
          process.env.MCODE_TERMINAL_BACKEND === "modern"
            ? c.resolve("ModernTerminalBackend") as ModernTerminalBackend
            : undefined,
        );
        return terminalBackendSelector;
      },
    } as never,
  );
  container.register<TerminalBackend>(TERMINAL_BACKEND_TOKEN, {
    useFactory: (c) => c.resolve<TerminalBackendSelector>("TerminalBackendSelector").getSelectedBackend(),
  });
  container.register(
    TerminalDiagnosticsService,
    {
      useFactory: (c: DependencyContainer) => {
        const terminalService = c.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN);
        if (terminalService.capabilities().backend === "modern") {
          return c.resolve<ModernTerminalBackend>("ModernTerminalBackend").getDiagnosticsService();
        }
        return new TerminalDiagnosticsService({
          backend: () => terminalService.capabilities().backend,
          health: () => ({
            contractVersion: 1,
            state: "healthy",
            hostGeneration: "0",
            activeSessions: Math.min(terminalService.listActiveSessions().length, TERMINAL_MAX_SESSIONS),
            lastHeartbeatMsAgo: null,
            queueBytes: 0,
            eventLoopLagMs: 0,
            hostRssBytes: "0",
          }),
        });
      },
    } as never,
  );
}

/** Register terminal settings and workspace preference services. */
export function registerTerminalPreferences(container: DependencyContainer): void {
  container.register(
    WorkspaceTerminalPreferencesService,
    { useClass: WorkspaceTerminalPreferencesService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(TerminalProfileService, {
    useFactory: (c) => new TerminalProfileService(
      c.resolve(SettingsService),
      c.resolve(WorkspaceTerminalPreferencesService),
    ),
  });
}
