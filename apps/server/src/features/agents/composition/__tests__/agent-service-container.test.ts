import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { container } from "tsyringe";

import { setupContainer } from "../../../../application/composition/container.js";
import { AgentService } from "../../orchestration/agent-service.js";
import { ThreadCreationCoordinator } from "../../turns/thread-creation-coordinator.js";
import { TURN_FEATURE_EFFECTS, TurnFeatureEffects } from "../../turns/turn-feature-effects.js";

describe("AgentService container composition", () => {
  let database: Database | undefined;
  let temporaryDirectory: string | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(() => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-service-composition-"));
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

  it("resolves AgentService through the production container with explicit feature effects", () => {
    expect(container.resolve<TurnFeatureEffects>(TURN_FEATURE_EFFECTS)).toBeInstanceOf(TurnFeatureEffects);
    expect(container.resolve(AgentService)).toBeInstanceOf(AgentService);
  });

  it("resolves ThreadService when a worktree thread reaches branch validation", async () => {
    const coordinator = container.resolve(ThreadCreationCoordinator);

    await expect(coordinator.create({
      workspaceId: "missing-workspace",
      title: "Invalid worktree branch",
      mode: "worktree",
      branch: "invalid branch",
      provider: "claude",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
    })).rejects.toThrow("Branch name contains invalid characters: invalid branch");
  });
});
