/**
 * Seeds the agent runtime database with the fixture workspace used by local automation.
 */

import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { logger } from "@mcode/shared";
import type { WorkspaceRepo } from "../../features/projects/persistence/workspace-repo.js";

/** Environment variables that opt the server into agent-runtime seeding. */
export interface AgentRuntimeSeedEnv {
  MCODE_AGENT_RUNTIME?: string;
  MCODE_AGENT_FIXTURE_REPO?: string;
}

/** Dependencies needed to seed the agent runtime workspace. */
export interface AgentRuntimeSeedDeps {
  workspaceRepo: WorkspaceRepo;
}

/**
 * Creates the fixture workspace when the server is running under `agent:up`.
 *
 * The seed is opt-in so regular dev, production, and CI starts behave exactly
 * as they do today. The workspace service keeps the operation idempotent by
 * returning an existing workspace for the same path.
 */
export function seedAgentRuntimeWorkspace(
  env: AgentRuntimeSeedEnv,
  deps: AgentRuntimeSeedDeps,
): void {
  if (env.MCODE_AGENT_RUNTIME !== "1") return;

  const fixtureRepo = env.MCODE_AGENT_FIXTURE_REPO?.trim();
  if (!fixtureRepo) {
    throw new Error("MCODE_AGENT_FIXTURE_REPO is required when MCODE_AGENT_RUNTIME=1");
  }
  if (!NodeFS.existsSync(fixtureRepo)) {
    throw new Error(`MCODE_AGENT_FIXTURE_REPO does not exist: ${fixtureRepo}`);
  }

  const existing = deps.workspaceRepo.findByPath(fixtureRepo);
  if (existing) {
    deps.workspaceRepo.touch(existing.id);
    deps.workspaceRepo.prependToSortOrder(existing.id);
    logger.info("Agent runtime fixture workspace already seeded", {
      workspaceId: existing.id,
      path: fixtureRepo,
    });
    return;
  }

  const workspace = deps.workspaceRepo.create(
    NodePath.basename(fixtureRepo) || "fixture-repo",
    fixtureRepo,
    true,
  );
  logger.info("Agent runtime fixture workspace seeded", {
    workspaceId: workspace.id,
    path: fixtureRepo,
  });
}
