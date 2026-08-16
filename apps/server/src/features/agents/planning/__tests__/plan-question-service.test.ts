import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../persistence/plan-question-answers-repo.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts";

/** Seed a workspace + thread so message foreign keys are satisfied. */
function seedThread(db: Database.Database): string {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "ws-1", "Test thread", "main", now, now);
  return "thread-1";
}

function insertMessage(
  db: Database.Database,
  id: string,
  role: string,
  content: string,
  sequence: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "thread-1", role, content, now, sequence);
}

/** A plan-questions fence with one question and two titled options. */
function fence(): string {
  const block = JSON.stringify([
    {
      id: "q1",
      category: "AUTH",
      question: "Which auth strategy?",
      options: [
        { id: "o1", title: "OAuth", description: "Use OAuth" },
        { id: "o2", title: "Sessions", description: "Use sessions" },
      ],
    },
  ]);
  return `Some preamble\n\n\`\`\`plan-questions\n${block}\n\`\`\``;
}

describe("PlanQuestionService.buildAnswerPayload", () => {
  let db: Database.Database;
  let svc: PlanQuestionService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    svc = new PlanQuestionService(new MessageRepo(db), new PlanQuestionAnswersRepo(db));
  });

  it("renders a selected option as human-readable question and option title", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);

    expect(content).toContain("**Which auth strategy?**: OAuth");
  });

  it("renders a free-text answer verbatim under the question label", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: null, freeText: "Use a magic link" },
    ]);

    expect(content).toContain("**Which auth strategy?**: Use a magic link");
  });

  it("renders (skipped) when neither an option nor free text is given", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: null, freeText: null },
    ]);

    expect(content).toContain("**Which auth strategy?**: (skipped)");
  });

  it("falls back to opaque ids when no fence or malformed JSON is present", () => {
    // Assistant message with a malformed plan-questions fence (not valid JSON).
    insertMessage(db, "m1", "assistant", "```plan-questions\nnot json```", 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);

    // No context resolved, so the raw ids surface instead of human text.
    expect(content).toContain("**q1**: o1");
  });

  it("appends plan-output instructions and keys the marker on the fenced message", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content, markPlanAnswerForMessageId } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);

    expect(content).toContain(PLAN_ANSWER_MESSAGE_PREFIX);
    expect(content).toContain("```plan-output");
    expect(markPlanAnswerForMessageId).toBe("m1");
  });
});

describe("PlanQuestionService.findLatestPlanQuestionsMessageId", () => {
  let db: Database.Database;
  let svc: PlanQuestionService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    svc = new PlanQuestionService(new MessageRepo(db), new PlanQuestionAnswersRepo(db));
  });

  it("returns the id of the most recent fenced assistant message", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);
    insertMessage(db, "m2", "user", "thanks", 2);
    insertMessage(db, "m3", "assistant", fence(), 3);

    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBe("m3");
  });

  it("returns null when the thread has no fenced message", () => {
    insertMessage(db, "m1", "assistant", "plain reply", 1);

    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBeNull();
  });

  it("ignores a fence that appears in a user message", () => {
    insertMessage(db, "m1", "user", fence(), 1);

    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBeNull();
  });
});

describe("PlanQuestionService.dismiss", () => {
  let db: Database.Database;
  let answersRepo: PlanQuestionAnswersRepo;
  let svc: PlanQuestionService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    answersRepo = new PlanQuestionAnswersRepo(db);
    svc = new PlanQuestionService(new MessageRepo(db), answersRepo);
  });

  it("marks the latest fenced message answered and returns its id", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const result = svc.dismiss("thread-1");

    expect(result).toBe("m1");
    expect(answersRepo.isAnswered("m1")).toBe(true);
  });

  it("returns null and writes nothing when there is no fenced message", () => {
    insertMessage(db, "m1", "assistant", "plain reply", 1);

    const result = svc.dismiss("thread-1");

    expect(result).toBeNull();
    expect(answersRepo.listAnsweredForThread("thread-1")).toEqual([]);
  });
});
