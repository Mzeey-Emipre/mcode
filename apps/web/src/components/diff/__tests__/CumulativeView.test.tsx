import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import { CumulativeView } from "../CumulativeView";

vi.mock("../SummaryView", () => ({
  SummaryView: () => <div data-testid="summary-lens">Summary lens</div>,
}));

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

describe("CumulativeView summary lens", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        diffSummary: { enabled: true },
      },
    });
  });

  it("toggles the Cumulative diff into its summary lens in place", async () => {
    render(
      <CumulativeView
        threadId="thread-1"
        snapshots={[
          {
            id: "snap-1",
            thread_id: "thread-1",
            message_id: "turn-1",
            ref_before: "a",
            ref_after: "b",
            files_changed: ["apps/web/src/a.ts"],
            worktree_path: null,
            created_at: "2026-06-12T10:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("a.ts")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("cumulative-summary-toggle"));

    expect(screen.getByTestId("summary-lens")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  it("hides the summary lens toggle when the setting is disabled", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        diffSummary: { enabled: false },
      },
    });

    render(
      <CumulativeView
        threadId="thread-1"
        snapshots={[
          {
            id: "snap-1",
            thread_id: "thread-1",
            message_id: "turn-1",
            ref_before: "a",
            ref_after: "b",
            files_changed: ["apps/web/src/a.ts"],
            worktree_path: null,
            created_at: "2026-06-12T10:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("cumulative-summary-toggle")).not.toBeInTheDocument();
  });
});
