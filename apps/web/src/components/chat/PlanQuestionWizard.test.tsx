import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanQuestion } from "@mcode/contracts";
import { mockTransport } from "@/__tests__/mocks/transport";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { PlanQuestionWizard } from "./PlanQuestionWizard";

vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => mockTransport,
}));

const threadId = "plan-thread";
const questions: PlanQuestion[] = [
  { id: "q1", category: "Architecture", question: "Choose storage", options: [
    { id: "sqlite", title: "SQLite", description: "Local", recommended: true },
    { id: "postgres", title: "Postgres", description: "Remote" },
  ] },
  { id: "q2", category: "Auth", question: "Choose auth", options: [
    { id: "password", title: "Password", description: "Built in", recommended: true },
    { id: "sso", title: "SSO", description: "External" },
  ] },
];

function seed(running = false) {
  resetThreadStoreForTests({
    records: new Map([[threadId, {
      ...createEmptyThreadRecord(),
      runtimePhase: running ? "running" : "idle",
      turnExecutionId: running ? "exec-plan" : null,
      planQuestions: questions,
      planAnswers: new Map(),
      planQuestionsStatus: "pending",
    }]]),
    runningThreadIds: running ? new Set([threadId]) : new Set(),
  });
}

describe("PlanQuestionWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("renders semantic options and advances after keyboard selection", () => {
    render(<PlanQuestionWizard threadId={threadId} />);
    expect(screen.getByRole("form", { name: "Plan questions" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Options" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);

    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByRole("radio", { name: /SQLite/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText("Choose auth")).toBeInTheDocument();
    expect(useThreadStore.getState().records.get(threadId)?.activeQuestionIndex).toBe(1);
  });

  it("cancels through the store and sends the durable dismissal transport", async () => {
    render(<PlanQuestionWizard threadId={threadId} />);
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(mockTransport.dismissPlanQuestions).toHaveBeenCalledWith(threadId));
    expect(screen.queryByRole("form", { name: "Plan questions" })).not.toBeInTheDocument();
  });

  it("locks submit and accept-recommended while the thread is running", () => {
    seed(true);
    render(<PlanQuestionWizard threadId={threadId} />);
    expect(screen.getByText("model is still working...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeEnabled();
    expect(screen.getByTestId("plan-accept-recommended")).toBeDisabled();
  });

  it("enables final submit when the running thread settles", () => {
    seed(true);
    useThreadStore.getState().setActiveQuestionIndex(threadId, 1);
    const { rerender } = render(<PlanQuestionWizard threadId={threadId} />);
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();

    useThreadStore.getState().applyThreadRuntimeSnapshot({
      threadId,
      turnExecutionId: "exec-plan",
      phase: "completed",
    });
    rerender(<PlanQuestionWizard threadId={threadId} />);
    expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
  });

  it("toggles the keyboard shortcut legend", () => {
    render(<PlanQuestionWizard threadId={threadId} />);
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("note", { name: "Keyboard shortcuts" })).toHaveTextContent("select");
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByRole("note", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("submits selected answers before a queued follow-up can be released", async () => {
    render(<PlanQuestionWizard threadId={threadId} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("radio", { name: /Password/ }));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(mockTransport.answerPlanQuestions).toHaveBeenCalledTimes(1));
    expect(mockTransport.answerPlanQuestions).toHaveBeenCalledWith(
      threadId,
      expect.arrayContaining([expect.objectContaining({ questionId: "q1", selectedOptionId: "sqlite" })]),
      "full", undefined, undefined, undefined,
    );
  });
});
