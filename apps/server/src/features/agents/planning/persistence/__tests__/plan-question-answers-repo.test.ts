import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { container } from "tsyringe";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../plan-question-answers-repo.js";

/**
 * Sidecar repo for the plan-question wizard's answered marker. The marker
 * lives keyed on the assistant message that contained the plan-questions
 * fence; cascading FKs to messages and threads keep the table self-pruning.
 */
describe("PlanQuestionAnswersRepo", () => {
  let db: Database;
  let repo: PlanQuestionAnswersRepo;
  let messageRepo: MessageRepo;
  let threadId: string;
  let assistantMsgId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    repo = container.resolve(PlanQuestionAnswersRepo);
    messageRepo = container.resolve(MessageRepo);

    const workspaceRepo = container.resolve(WorkspaceRepo);
    const threadRepo = container.resolve(ThreadRepo);
    const ws = workspaceRepo.create("test-ws", "/tmp/ws", false);
    const t = threadRepo.create(ws.id, "thread", "direct", "main");
    threadId = t.id;

    const msg = messageRepo.create(threadId, "assistant", "```plan-questions\n[]\n```", 1);
    assistantMsgId = msg.id;
  });

  it("isAnswered returns false when no marker exists", () => {
    expect(repo.isAnswered(assistantMsgId)).toBe(false);
  });

  it("markAnswered persists the marker; isAnswered then returns true", () => {
    repo.markAnswered(assistantMsgId, threadId);
    expect(repo.isAnswered(assistantMsgId)).toBe(true);
  });

  it("listAnsweredForThread returns marker IDs scoped to the thread", () => {
    const workspaceRepo = container.resolve(WorkspaceRepo);
    const threadRepo = container.resolve(ThreadRepo);
    const ws2 = workspaceRepo.create("other-ws", "/tmp/other-ws", false);
    const otherThread = threadRepo.create(ws2.id, "other", "direct", "main");
    const otherMsg = messageRepo.create(
      otherThread.id,
      "assistant",
      "```plan-questions\n[]\n```",
      1,
    );

    repo.markAnswered(assistantMsgId, threadId);
    repo.markAnswered(otherMsg.id, otherThread.id);

    expect(repo.listAnsweredForThread(threadId)).toEqual([assistantMsgId]);
    expect(repo.listAnsweredForThread(otherThread.id)).toEqual([otherMsg.id]);
  });

  it("re-marking the same message id is idempotent", () => {
    repo.markAnswered(assistantMsgId, threadId);
    expect(() => repo.markAnswered(assistantMsgId, threadId)).not.toThrow();
    expect(repo.listAnsweredForThread(threadId)).toEqual([assistantMsgId]);
  });

  it("FK cascade: deleting the parent message removes the marker", () => {
    repo.markAnswered(assistantMsgId, threadId);
    expect(repo.isAnswered(assistantMsgId)).toBe(true);

    db.prepare("DELETE FROM messages WHERE id = ?").run(assistantMsgId);
    expect(repo.isAnswered(assistantMsgId)).toBe(false);
  });
});
