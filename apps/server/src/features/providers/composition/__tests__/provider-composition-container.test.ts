import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import {
  AgentEventType,
  type ProviderEventBatch,
} from "@mcode/contracts";
import type { ProviderHostPorts } from "@mcode/providers";

import { setupContainer } from "../../../../application/composition/container.js";
import { CanonicalAgentBoundary } from "../../../agents/canonical/canonical-agent-boundary.js";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import { ProviderRegistry } from "../provider-registry.js";
import { ProviderEventIngress, type ProviderEventIngressEvent } from "../provider-event-ingress.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-28T12:00:00.000Z";

function seedThread(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("workspace-1", "Workspace", "C:/workspace", NOW, NOW);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "workspace-1", "Thread", "main", "cursor", NOW, NOW);
}

function runtimeBatch(): ProviderEventBatch {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    executionId: EXECUTION_ID,
    phase: "running",
    events: [{
      eventId: "cursor:runtime-event-1",
      routing: {
        threadId: "thread-1",
        turnId: "turn-1",
        executionId: EXECUTION_ID,
        itemId: "cursor:runtime-item-1",
      },
      sourceProviderId: "cursor",
      sourceIdentities: [],
      sourceSequence: 1,
      payload: {
        type: "item.recorded",
        item: {
          id: "cursor:runtime-item-1",
          threadId: "thread-1",
          turnId: "turn-1",
          kind: "system",
          providerIdentities: [],
          payload: {
            projection: "providerRuntimeEvent",
            runtimeEvent: {
              event: {
                type: AgentEventType.TextDelta,
                threadId: "thread-1",
                turnExecutionId: EXECUTION_ID,
                delta: "canonical delivery",
              },
            },
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    }],
  };
}

async function flushIngress(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("provider composition container", () => {
  let database: Database.Database | undefined;
  let temporaryDirectory: string | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(() => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-provider-composition-"));
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    setupContainer(temporaryDirectory);
    database = container.resolve<Database.Database>("Database");
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

  it("constructs providers before ingress starts and hands canonical commits to ingress", async () => {
    const host = container.resolve<ProviderHostPorts>("ProviderHostPorts");
    const ingress = container.resolve(ProviderEventIngress);
    const registry = container.resolve(ProviderRegistry);
    const providers = registry.resolveAll();
    const received: ProviderEventIngressEvent[] = [];

    expect(providers.map((provider) => provider.id)).toEqual(expect.arrayContaining([
      "claude", "copilot", "codex", "cursor",
    ]));

    ingress.start(registry, {
      handleProviderEvent: (event) => received.push(event),
      handleProviderFileMutation: () => undefined,
    });

    seedThread(database!);
    const canonical = container.resolve(CanonicalAgentBoundary);
    const messages = container.resolve(MessageRepo);
    canonical.startParentTurn({
      thread: { id: "thread-1", workspaceId: "workspace-1", providerId: "cursor", createdAt: NOW },
      turnId: "turn-1",
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messages.create("thread-1", "user", "Start", 1),
    });

    await expect(host.events.submit(runtimeBatch())).resolves.toMatchObject({
      commit: { outcome: "committed", eventCount: 1 },
      delivery: { ingress: "queued" },
    });
    await flushIngress();

    expect(received).toEqual([expect.objectContaining({
      providerId: "cursor",
      sourceKind: "canonical-commit",
      event: expect.objectContaining({ delta: "canonical delivery" }),
      canonicalReceipt: expect.objectContaining({ eventId: "cursor:runtime-event-1" }),
    })]);
  });
});
