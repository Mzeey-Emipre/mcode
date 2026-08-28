import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { container } from "tsyringe";

import { setupContainer } from "../../../../application/composition/container.js";
import { AgentService } from "../../orchestration/agent-service.js";
import { TURN_FEATURE_EFFECTS, TurnFeatureEffects } from "../../turns/turn-feature-effects.js";

describe("AgentService container composition", () => {
  let database: Database.Database | undefined;
  let temporaryDirectory: string | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(() => {
    container.reset();
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mcode-agent-service-composition-"));
    process.env.MCODE_DB_PATH = join(temporaryDirectory, "mcode.db");
    setupContainer(temporaryDirectory);
    database = container.resolve<Database.Database>("Database");
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("resolves AgentService through the production container with explicit feature effects", () => {
    expect(container.resolve<TurnFeatureEffects>(TURN_FEATURE_EFFECTS)).toBeInstanceOf(TurnFeatureEffects);
    expect(container.resolve(AgentService)).toBeInstanceOf(AgentService);
  });
});
