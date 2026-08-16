import type { PullRequestSummary } from "@mcode/contracts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getPullRequestDetailKey,
  usePullRequestDetailStore,
} from "@/features/pull-requests/state/pullRequestDetailStore";
import { usePullRequestStore } from "@/features/pull-requests/state/pullRequestStore";
import { useUiStore } from "@/stores/uiStore";
import type { PullRequestTransport } from "@/transport/pull-requests";

const layout = vi.hoisted(() => ({ width: 420 }));
const inboxMounts = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/hooks/useElementWidth", () => ({
  useElementWidth: () => layout.width,
}));

vi.mock("../PullRequestInbox", async () => {
  const { useEffect } = await import("react");
  return {
    PullRequestInbox: ({
      onActivate,
      listboxRef,
      transport,
    }: {
      onActivate?: (key: string) => void;
      listboxRef?: { current: HTMLDivElement | null };
      transport?: PullRequestTransport;
    }) => {
      useEffect(() => {
        inboxMounts.count += 1;
        void transport?.list({} as never);
      }, [transport]);
      return (
        <div
          ref={listboxRef}
          role="listbox"
          tabIndex={0}
          aria-label="Pull requests"
        >
          <button type="button" onClick={() => onActivate?.("github:R_repo:1")}>
            Activate pull request
          </button>
        </div>
      );
    },
  };
});

vi.mock("../PullRequestDetailPane", () => ({
  PullRequestDetailPane: ({
    summaryFallback,
    onClose,
    backButtonRef,
    reserveSidebarReveal,
  }: {
    summaryFallback?: PullRequestSummary | null;
    onClose: () => void;
    backButtonRef?: Ref<HTMLButtonElement>;
    reserveSidebarReveal?: boolean;
  }) => (
    <div aria-label="Selected pull request">
      {reserveSidebarReveal && (
        <span data-testid="pull-request-sidebar-reveal-spacer" />
      )}
      <span>{summaryFallback?.title}</span>
      <button ref={backButtonRef} type="button" onClick={onClose}>
        Back to inbox
      </button>
    </div>
  ),
}));

import { PullRequestSurface } from "../PullRequestSurface";

function summary(): PullRequestSummary {
  return {
    identity: {
      provider: "github",
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 1,
    },
    url: "https://github.com/Mzeey-Empire/mcode/pull/1",
    title: "Read pull request detail",
    author: null,
    state: "open",
    readiness: "ready",
    head: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "codex/read-detail",
      oid: "a".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "b".repeat(40),
    },
    relationships: ["authored"],
    checks: { state: "pending" },
    commentCount: 0,
    additions: 12,
    deletions: 3,
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

function fakeTransport(): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false }),
    get: vi.fn().mockResolvedValue({ ok: false }),
    timeline: vi.fn().mockResolvedValue({ ok: false }),
    files: vi.fn().mockResolvedValue({ ok: false }),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
  };
}

function seedSelection(): void {
  const item = summary();
  const key = getPullRequestDetailKey(item.identity);
  usePullRequestStore.setState({
    entities: { [key]: item },
    orderedKeys: [key],
    selectedKey: key,
    status: "ready",
  });
}

function renderSurface(transport?: PullRequestTransport) {
  return render(
    <TooltipProvider>
      <PullRequestSurface transport={transport} />
    </TooltipProvider>,
  );
}

describe("PullRequestSurface", () => {
  beforeEach(() => {
    layout.width = 420;
    inboxMounts.count = 0;
    usePullRequestStore.getState().reset();
    usePullRequestDetailStore.setState({ entries: {}, activeKey: null });
    useUiStore.setState({
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: false,
    });
  });

  it("keeps a collapsed sidebar recoverable from the surface header", () => {
    useUiStore.setState({
      sidebarCollapsed: true,
      sidebarCollapsedByLayout: true,
    });
    renderSurface();

    const reveal = screen.getByRole("button", { name: "Expand sidebar" });
    expect(reveal).toBeVisible();
    fireEvent.click(reveal);

    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
  });

  it("reserves the sidebar reveal slot beside the narrow detail back action", async () => {
    useUiStore.setState({
      sidebarCollapsed: true,
      sidebarCollapsedByLayout: true,
    });
    const transport = fakeTransport();
    seedSelection();
    renderSurface(transport);

    fireEvent.click(
      screen.getByRole("button", { name: "Activate pull request" }),
    );

    expect(
      await screen.findByTestId("pull-request-sidebar-reveal-spacer"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand sidebar" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to inbox" })).toBeVisible();
  });

  it("starts at 420px in the mounted inbox and loads detail only after activation", async () => {
    const transport = fakeTransport();
    seedSelection();
    renderSurface(transport);

    expect(
      screen.getByRole("listbox", { name: "Pull requests" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Selected pull request")).toBeNull();
    expect(usePullRequestDetailStore.getState().activeKey).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Activate pull request" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Selected pull request")).toBeVisible(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Back to inbox" }),
      ).toHaveFocus(),
    );
    expect(screen.getByTestId("pull-request-inbox-pane")).not.toBeVisible();
  });

  it("keeps the wide inbox focused until the user explicitly activates a pull request", async () => {
    const transport = fakeTransport();
    seedSelection();
    layout.width = 1_000;
    const view = renderSurface(transport);

    expect(screen.queryByLabelText("Selected pull request")).toBeNull();
    expect(screen.getByTestId("pull-request-inbox-pane")).toHaveClass("w-full");
    expect(
      screen.getByRole("listbox", { name: "Pull requests" }).closest("section"),
    ).toHaveAttribute("data-layout", "master-detail");

    fireEvent.click(
      screen.getByRole("button", { name: "Activate pull request" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Selected pull request")).toBeVisible(),
    );
    expect(screen.getByTestId("pull-request-inbox-pane")).toHaveClass(
      "min-w-[360px]",
      "flex-1",
    );
    expect(
      screen.getByRole("separator", { name: "Resize pull request detail" }),
    ).toBeVisible();

    const detailPanel = screen.getByTestId("pull-request-detail-panel");
    const initialWidth = Number.parseFloat(detailPanel.style.width);
    fireEvent.mouseDown(
      screen.getByRole("separator", { name: "Resize pull request detail" }),
      { clientX: 540 },
    );
    fireEvent.mouseMove(document, { clientX: 500 });
    fireEvent.mouseUp(document);
    expect(Number.parseFloat(detailPanel.style.width)).toBe(initialWidth + 40);

    view.unmount();
  });

  it("keeps the narrow inbox mounted and restores focus without another inbox read", async () => {
    const transport = fakeTransport();
    seedSelection();
    renderSurface(transport);
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(1));
    expect(inboxMounts.count).toBe(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Activate pull request" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Selected pull request")).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(
      screen.getByRole("listbox", { name: "Pull requests" }),
    ).toHaveFocus();
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(inboxMounts.count).toBe(1);
  });
});
