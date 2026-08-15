import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { setupContainer } from "../../container.js";
import { TERMINAL_BACKEND_TOKEN, type TerminalBackend } from "../terminal-backend.js";
import { TerminalDiagnosticsService } from "./terminal-diagnostics-service.js";

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
  const previousBackend = process.env.MCODE_TERMINAL_BACKEND;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(() => {
    container.reset();
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mcode-terminal-diagnostics-"));
    process.env.MCODE_TERMINAL_BACKEND = "modern";
    process.env.MCODE_DB_PATH = join(temporaryDirectory, "mcode.db");
    setupContainer(temporaryDirectory);
    database = container.resolve<Database.Database>("Database");

    const modernBackend = {
      capabilities: () => MODERN_CAPABILITIES,
      listActiveSessions: () => {
        throw new Error("Use terminal.session.list");
      },
    } as unknown as TerminalBackend;
    container.register("ModernTerminalBackend", { useValue: modernBackend });
    container.register("ModernTerminalSessionService", {
      useValue: { listSessions: () => [{ sessionId: "one" }, { sessionId: "two" }] },
    });
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
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("resolves diagnostics with modern selection and uses the session service count", () => {
    const diagnostics = container.resolve(TerminalDiagnosticsService);
    const bundle = diagnostics.getBundle();

    expect(bundle.backend).toBe("modern");
    expect(bundle.health.activeSessions).toBe(2);
    expect(container.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN).capabilities()).toEqual(
      MODERN_CAPABILITIES,
    );
  });
});
