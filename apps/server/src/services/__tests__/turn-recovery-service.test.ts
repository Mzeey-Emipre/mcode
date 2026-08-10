import "reflect-metadata";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../store/database.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { ThreadRepo } from "../../repositories/thread-repo.js";
import { CanonicalAgentEventSink } from "../canonical-agent-event-sink.js";
import { TurnRecoveryService } from "../turn-recovery-service.js";
import { AttachmentService } from "../attachment-service.js";
import type { SendMessageCommand } from "../agent-service.js";

const NOW = "2026-08-10T09:00:00.000Z";
const THREAD_ID = "thread-recovery";
const TURN_ID = "turn-recovery";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000015";

describe("TurnRecoveryService", () => {
  let db: Database.Database;
  let sink: CanonicalAgentEventSink;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("workspace-recovery", "Workspace", "C:/workspace", NOW, NOW);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "workspace-recovery", "Recovery", "main", "codex", "active", NOW, NOW);
    sink = new CanonicalAgentEventSink(db, vi.fn());
    threadRepo = new ThreadRepo(db);
    const messageRepo = new MessageRepo(db);
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-recovery",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [{
        providerId: "codex",
        scope: "thread",
        value: "native-cursor-15",
        provenance: "native",
      }],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "repeat only when asked", 1),
    });
  });

  it("interrupts every execution that lacks exact provider proof at startup", () => {
    const service = new TurnRecoveryService(sink, threadRepo, new AttachmentService());

    const result = service.reconcileOnStartup();

    expect(result).toEqual({ interrupted: [EXECUTION_ID] });
    expect(sink.loadTurn(TURN_ID)?.status).toBe("Interrupted");
    expect(threadRepo.findById(THREAD_ID)?.status).toBe("interrupted");
  });

  it("offers Retry but never Resume for an unproved native cursor", () => {
    const service = new TurnRecoveryService(sink, threadRepo, new AttachmentService());
    service.reconcileOnStartup();

    expect(service.listRecoveries()).toEqual([{
      threadId: THREAD_ID,
      executionId: EXECUTION_ID,
      acceptedThrough: 6,
      durableThrough: 6,
      phase: "interrupted",
      error: "The provider could not prove that this execution was still active after restart.",
      actions: ["retry"],
    }]);
  });

  it("dispatches an explicit Retry as a fresh execution with the accepted user input", async () => {
    const service = new TurnRecoveryService(sink, threadRepo, new AttachmentService());
    service.reconcileOnStartup();
    const dispatched: SendMessageCommand[] = [];
    const dispatch = vi.fn(async (command: SendMessageCommand) => {
      dispatched.push(command);
    });

    await service.retry(EXECUTION_ID, dispatch);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD_ID,
      content: "repeat only when asked",
      provider: "codex",
      forceFreshSession: true,
      retryOfExecutionId: EXECUTION_ID,
    }));

    const retryCommand = dispatched[0]!;
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-recovery",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: "turn-retry",
      executionId: "00000000-0000-4000-8000-000000000016",
      permissionMode: "supervised",
      providerIdentities: [],
      retryOfExecutionId: retryCommand.retryOfExecutionId,
      projectUserMessage: () => new MessageRepo(db).create(
        THREAD_ID,
        "user",
        retryCommand.content,
        2,
      ),
    });

    expect(sink.listInterruptedCheckpoints()).toEqual([]);
    expect(sink.loadCheckpoint(EXECUTION_ID)?.phase).toBe("retried");
  });
});
