import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalLookupResult, GoalState } from "@mcode/contracts";

const sendMessage = vi.fn();
const refreshThreadGoal = vi.fn();
const clearThreadGoal = vi.fn();
const showToast = vi.fn();

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: (selector: (state: unknown) => unknown) =>
    selector({ sendMessage, refreshThreadGoal, clearThreadGoal }),
  scheduleDrainAfterEdit: vi.fn(),
  getHandoffStatus: vi.fn(),
}));

vi.mock("@/stores/toastStore", () => ({
  useToastStore: {
    getState: () => ({ show: showToast }),
  },
}));

import { ActiveGoalChip } from "@/features/conversation";

const goal: GoalState = {
  threadId: "thread-1",
  objective: "Ship app-level goal controls",
  status: "active",
  tokenBudget: 1000,
  tokensUsed: 42,
  timeUsedSeconds: 12,
  createdAt: 1_767_000_000,
  updatedAt: 1_767_000_010,
  providerId: "codex",
  source: "codex",
  controls: { canInspect: true, canClear: true },
};

const otherGoal: GoalState = {
  ...goal,
  threadId: "thread-2",
  objective: "Review the branch",
};

function lookup(overrides: Partial<GoalLookupResult> = {}): GoalLookupResult {
  return {
    goal,
    authoritative: true,
    source: "codex-native",
    ...overrides,
  };
}

describe("ActiveGoalChip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshThreadGoal.mockResolvedValue(lookup());
    clearThreadGoal.mockResolvedValue(lookup({ goal: null }));
  });

  it("opens details through refreshThreadGoal and does not send a chat message", async () => {
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText(/Show active goal/));

    expect(refreshThreadGoal).toHaveBeenCalledWith("thread-1");
    expect(sendMessage).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText("Ship app-level goal controls")).toBeInTheDocument(),
    );
    expect(screen.getByText("Tokens used")).toBeInTheDocument();
    expect(screen.getByText("Token budget")).toBeInTheDocument();
    expect(screen.getByText("Goal source")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("codex-native")).toBeInTheDocument());
  });

  it("keeps prior details visible and shows refresh failure inline", async () => {
    refreshThreadGoal.mockRejectedValue(new Error("offline"));
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText(/Show active goal/));

    await waitFor(() =>
      expect(screen.getByText("Ship app-level goal controls")).toBeInTheDocument(),
    );
    expect(await screen.findByText("Could not refresh goal details.")).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("clears through clearThreadGoal and does not send a chat message", async () => {
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText("Clear active goal"));

    expect(clearThreadGoal).toHaveBeenCalledWith("thread-1");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("disables visible clear controls and shows pending text while clearing", async () => {
    let resolveClear!: (result: GoalLookupResult) => void;
    clearThreadGoal.mockReturnValue(new Promise((resolve) => {
      resolveClear = resolve;
    }));
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText(/Show active goal/));
    await userEvent.click(await screen.findByRole("button", { name: "Clear goal" }));

    expect(screen.getAllByText("Clearing...").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Clearing..." })).toBeDisabled();
    resolveClear(lookup({ goal: null }));
  });

  it("does not leave refresh pending when same-thread clear overlaps details refresh", async () => {
    let resolveRefresh!: (result: GoalLookupResult) => void;
    let resolveClear!: (result: GoalLookupResult) => void;
    refreshThreadGoal.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    clearThreadGoal.mockReturnValueOnce(new Promise((resolve) => {
      resolveClear = resolve;
    }));
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText(/Show active goal/));
    await userEvent.click(await screen.findByRole("button", { name: "Clear goal" }));

    await waitFor(() => expect(screen.getAllByText("Clearing...").length).toBeGreaterThanOrEqual(1));
    resolveClear(lookup({
      goal: null,
      authoritative: false,
      source: "codex-cache",
      reason: "not-materialized",
    }));
    await waitFor(() => expect(screen.queryByText("Clearing...")).not.toBeInTheDocument());
    expect(screen.getByText("codex-cache")).toBeInTheDocument();
    expect(screen.getByText("not-materialized")).toBeInTheDocument();

    resolveRefresh(lookup({ source: "codex-native", reason: "missing" }));
    await waitFor(() => expect(screen.queryByText("Refreshing...")).not.toBeInTheDocument());
    expect(screen.getByText("codex-cache")).toBeInTheDocument();
    expect(screen.getByText("not-materialized")).toBeInTheDocument();
    expect(screen.queryByText("codex-native")).not.toBeInTheDocument();
    expect(screen.queryByText("missing")).not.toBeInTheDocument();
  });

  it("shows a not-cleared toast for non-authoritative open-goal results", async () => {
    clearThreadGoal.mockResolvedValue(lookup({ authoritative: false }));
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText("Clear active goal"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "info",
        "Goal was not cleared",
        "The provider did not report an active goal to clear.",
      ),
    );
  });

  it("shows an unavailable toast for unsupported clear results", async () => {
    clearThreadGoal.mockResolvedValue(lookup({
      goal: null,
      source: "unsupported",
      reason: "unsupported-provider",
    }));
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText("Clear active goal"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "error",
        "Goal controls unavailable",
        "This provider does not support app-level goal controls.",
      ),
    );
  });

  it("shows the normalized RPC error when clear throws", async () => {
    clearThreadGoal.mockRejectedValue(new Error("clear failed"));
    render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText("Clear active goal"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("error", "Could not clear goal", "clear failed"),
    );
  });

  it("resets details and ignores stale refresh results after thread changes", async () => {
    let resolveRefresh!: (result: GoalLookupResult) => void;
    refreshThreadGoal.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const { rerender } = render(<ActiveGoalChip threadId="thread-1" goal={goal} />);

    await userEvent.click(screen.getByLabelText(/Show active goal/));
    expect(refreshThreadGoal).toHaveBeenCalledWith("thread-1");

    rerender(<ActiveGoalChip threadId="thread-2" goal={otherGoal} />);
    resolveRefresh(lookup({ source: "codex-native", reason: "missing" }));
    await waitFor(() => expect(screen.queryByText("Lookup source")).not.toBeInTheDocument());

    await userEvent.click(screen.getByLabelText(/Show active goal/));
    expect(screen.getByText("Review the branch")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("codex-native")).toBeInTheDocument());
  });
});
