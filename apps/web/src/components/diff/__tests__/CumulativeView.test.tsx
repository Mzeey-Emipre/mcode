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

vi.mock("@/transport", () => ({
  getTransport: () => ({
    getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
    listSnapshots: vi.fn().mockResolvedValue([]),
  }),
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
        comparison={{
          files: [{ path: "apps/web/src/a.ts", previousPath: null, changeType: "modified", binary: false }],
          additions: 1,
          deletions: 0,
        }}
        cacheVersion="snap-1"
        turnCount={1}
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
        comparison={{
          files: [{ path: "apps/web/src/a.ts", previousPath: null, changeType: "modified", binary: false }],
          additions: 1,
          deletions: 0,
        }}
        cacheVersion="snap-1"
        turnCount={1}
      />,
    );

    expect(screen.queryByTestId("cumulative-summary-toggle")).not.toBeInTheDocument();
  });

  it("shows the scoped diff when a subagent scope replaces an open summary lens", async () => {
    const comparison = {
      files: [{ path: "apps/web/src/a.ts", previousPath: null, changeType: "modified" as const, binary: false }],
      additions: 1,
      deletions: 0,
    };
    const { rerender } = render(
      <CumulativeView
        threadId="thread-1"
        comparison={comparison}
        cacheVersion="snap-1"
        turnCount={1}
      />,
    );

    await userEvent.click(screen.getByTestId("cumulative-summary-toggle"));
    expect(screen.getByTestId("summary-lens")).toBeInTheDocument();

    rerender(
      <CumulativeView
        threadId="thread-1"
        comparison={comparison}
        cacheVersion="snap-1"
        turnCount={1}
        scopeLabel="explorer_state"
      />,
    );

    expect(screen.queryByTestId("summary-lens")).not.toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });
});
