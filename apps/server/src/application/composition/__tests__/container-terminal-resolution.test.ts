import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";

import { TERMINAL_BACKEND_TOKEN, type TerminalBackend } from "../../../features/terminal/backends/terminal-backend.js";
import { WindowsProcessScopeFactory } from "../../../runtime/process/containment/windows-process-scope.js";
import { setupContainer } from "../container.js";

const SENTINEL_HOST_RUNTIME: HostRuntime = Object.freeze({
  platform: "linux",
  architecture: "ia32",
  nodeAbi: "test-abi",
});

describe("server container terminal composition", () => {
  let database: Database | undefined;
  let temporaryDirectory: string | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;
  const previousBackend = process.env.MCODE_TERMINAL_BACKEND;

  beforeEach(() => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-container-terminal-"));
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    process.env.MCODE_TERMINAL_BACKEND = "legacy";
    setupContainer(temporaryDirectory);
    container.register<HostRuntime>("HostRuntime", { useValue: SENTINEL_HOST_RUNTIME });
    database = container.resolve<Database>("Database");
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (previousBackend === undefined) delete process.env.MCODE_TERMINAL_BACKEND;
    else process.env.MCODE_TERMINAL_BACKEND = previousBackend;
    if (temporaryDirectory) NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("passes registered host facts to the terminal process-scope factory", () => {
    const scope = container.resolve(WindowsProcessScopeFactory).create();
    try {
      expect(scope.ready).toBe(false);
    } finally {
      scope.close();
    }
    expect(container.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN).capabilities().backend).toBe("legacy");
  });
});
