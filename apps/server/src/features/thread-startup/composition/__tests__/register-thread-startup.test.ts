import "reflect-metadata";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { container } from "tsyringe";
import { setupContainer } from "../../../../application/composition/container.js";
import { ThreadStartupService } from "../../thread-startup-service.js";

describe("registerThreadStartupServices", () => {
  let database: Database | undefined;
  let temporaryDirectory: string | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(() => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "mcode-thread-startup-composition-"),
    );
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    setupContainer(temporaryDirectory);
    database = container.resolve<Database>("Database");
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (temporaryDirectory) NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("resolves a cached startup service through the production container", () => {
    const service = container.resolve(ThreadStartupService);

    expect(service).toBeInstanceOf(ThreadStartupService);
    expect(container.resolve(ThreadStartupService)).toBe(service);
  });
});
