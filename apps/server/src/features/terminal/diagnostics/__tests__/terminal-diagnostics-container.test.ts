import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";
import { setupContainer } from "../../../../application/composition/container.js";
import { AgentService } from "../../../agents/index.js";
import { HandoffCheckoutService } from "../../../handoff/index.js";
import { GitWatcherService, WorkspaceService } from "../../../projects/index.js";
import { TERMINAL_BACKEND_TOKEN, type TerminalBackend } from "../../backends/terminal-backend.js";
import { TerminalDiagnosticsService } from "../terminal-diagnostics-service.js";

const MODERN_CAPABILITIES = {
  contractVersion: 1,
  backend: "modern",
  selectedAt: "2026-08-15T00:00:00.000Z",
  publicFrameVersion: 1,
  recovery: { replay: true, checkpoint: true, gap: true },
  host: { state: "healthy" as const, generation: "7" },
  sessionLimit: 20,
};

describe("Terminal diagnostics container wiring", () => {
  let database: Database.Database | undefined;
  let temporaryDirectory: string | undefined;
  let modernDiagnostics: TerminalDiagnosticsService;
  const previousBackend = process.env.MCODE_TERMINAL_BACKEND;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(() => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-terminal-diagnostics-"));
    process.env.MCODE_TERMINAL_BACKEND = "modern";
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    setupContainer(temporaryDirectory);
    database = container.resolve<Database.Database>("Database");

    modernDiagnostics = new TerminalDiagnosticsService({
      backend: () => "modern",
      health: () => ({
        contractVersion: 1,
        state: "healthy",
        hostGeneration: "7",
        activeSessions: 2,
        lastHeartbeatMsAgo: 11,
        queueBytes: 43,
        eventLoopLagMs: 5,
        hostRssBytes: "2048",
      }),
    });
    const modernBackend = {
      capabilities: () => MODERN_CAPABILITIES,
      listActiveSessions: () => {
        throw new Error("Use terminal.session.list");
      },
      getDiagnosticsService: () => modernDiagnostics,
    } as unknown as TerminalBackend;
    container.register("ModernTerminalBackend", { useValue: modernBackend });
  });

  afterEach(() => {
    if (!database && container.isRegistered("Database")) {
      database = container.resolve<Database.Database>("Database");
    }
    database?.close();
    database = undefined;
    container.reset();
    if (previousBackend === undefined) delete process.env.MCODE_TERMINAL_BACKEND;
    else process.env.MCODE_TERMINAL_BACKEND = previousBackend;
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (temporaryDirectory) NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("routes backend-owned modern health measurements through diagnostics RPC", async () => {
    const diagnostics = container.resolve(TerminalDiagnosticsService);
    expect(diagnostics).toBe(modernDiagnostics);
    const response = await routeMessage(JSON.stringify({
      id: "modern_bundle",
      method: "terminal.diagnostics.getBundle",
      params: {},
    }), { terminalDiagnosticsService: diagnostics } as unknown as RouterDeps);

    expect(response).toMatchObject({
      id: "modern_bundle",
      result: {
        backend: "modern",
        health: {
          lastHeartbeatMsAgo: 11,
          queueBytes: 43,
          eventLoopLagMs: 5,
          hostRssBytes: "2048",
        },
      },
    });
    expect(container.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN).capabilities()).toEqual(
      MODERN_CAPABILITIES,
    );
  });

  it("resolves workspace, agent, Git watcher, and Handoff lifecycles through the configured container", () => {
    expect(container.resolve(WorkspaceService)).toBeInstanceOf(WorkspaceService);
    expect(container.resolve(AgentService)).toBeInstanceOf(AgentService);
    expect(container.resolve(GitWatcherService)).toBeInstanceOf(GitWatcherService);
    expect(container.resolve(HandoffCheckoutService)).toBeInstanceOf(HandoffCheckoutService);
  });

  it("caps legacy active sessions at the diagnostics schema limit", async () => {
    process.env.MCODE_TERMINAL_BACKEND = "legacy";
    container.register<TerminalBackend>(TERMINAL_BACKEND_TOKEN, {
      useValue: {
        capabilities: () => ({
          contractVersion: 0,
          backend: "legacy",
          publicFrameVersion: 0,
          recovery: { replay: true, checkpoint: true, gap: true },
        }),
        listActiveSessions: () => Array.from(
          { length: 25 },
          (_, index) => ({ ptyId: `pty-${index}`, threadId: "thread" }),
        ),
      } as unknown as TerminalBackend,
    });

    const diagnostics = container.resolve(TerminalDiagnosticsService);
    const response = await routeMessage(JSON.stringify({
      id: "legacy_bundle",
      method: "terminal.diagnostics.getBundle",
      params: {},
    }), { terminalDiagnosticsService: diagnostics } as unknown as RouterDeps);

    expect(response).toMatchObject({
      id: "legacy_bundle",
      result: { backend: "legacy", health: { activeSessions: 20 } },
    });
  });
});
