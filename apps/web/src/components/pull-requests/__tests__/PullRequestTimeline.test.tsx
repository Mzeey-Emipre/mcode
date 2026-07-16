import type { PullRequestTimelineItem } from "@mcode/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestTimeline } from "../PullRequestTimeline";

const virtualizerProbe = vi.hoisted(() => ({
  options: [] as Array<{
    count: number;
    overscan: number;
    estimateSize: (index: number) => number;
    measureElement: (
      element: HTMLLIElement,
      entry: ResizeObserverEntry | undefined,
      instance: unknown,
    ) => number;
    getItemKey: (index: number) => unknown;
  }>,
  measureElement: vi.fn(),
  scrollToIndex: vi.fn(),
}));
const formatProbe = vi.hoisted(() => ({
  calls: new Map<string, number>(),
}));

vi.mock("@/lib/format-relative", () => ({
  formatRelative: (value: string) => {
    formatProbe.calls.set(value, (formatProbe.calls.get(value) ?? 0) + 1);
    return value;
  },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    overscan: number;
    estimateSize: (index: number) => number;
    measureElement: (
      element: HTMLLIElement,
      entry: ResizeObserverEntry | undefined,
      instance: unknown,
    ) => number;
    getItemKey: (index: number) => unknown;
  }) => {
    virtualizerProbe.options.push(options);
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 12) }, (_, index) => ({
          index,
          key: options.getItemKey(index),
          start: index * options.estimateSize(index),
          size: options.estimateSize(index),
          end: (index + 1) * options.estimateSize(index),
          lane: 0,
        })),
      getTotalSize: () => options.count * options.estimateSize(0),
      measureElement: virtualizerProbe.measureElement,
      scrollToIndex: virtualizerProbe.scrollToIndex,
    };
  },
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
    viewportRef,
  }: {
    children: React.ReactNode;
    className?: string;
    viewportRef?: React.Ref<HTMLDivElement>;
  }) => (
    <div ref={viewportRef} className={className} data-testid="timeline-viewport">
      {children}
    </div>
  ),
}));

function opened(providerNodeId: string, occurredAt: string): PullRequestTimelineItem {
  return {
    kind: "opened",
    providerNodeId,
    occurredAt,
    actor: null,
    url: null,
  };
}

function bounds(top: number, bottom = top + 20): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom,
    left: 0,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

describe("PullRequestTimeline", () => {
  beforeEach(() => {
    virtualizerProbe.options.length = 0;
    virtualizerProbe.measureElement.mockClear();
    virtualizerProbe.scrollToIndex.mockClear();
    formatProbe.calls.clear();
  });

  it("sorts by occurrence time and provider ID with ordered-list semantics", async () => {
    const items: PullRequestTimelineItem[] = [
      {
        kind: "issue_comment",
        providerNodeId: "node-z",
        occurredAt: "2026-07-11T12:02:00.000Z",
        updatedAt: "2026-07-11T12:02:00.000Z",
        actor: null,
        url: null,
        body: "**Later body**",
      },
      opened("node-b", "2026-07-11T12:00:00.000Z"),
      {
        kind: "review",
        providerNodeId: "node-a",
        occurredAt: "2026-07-11T12:00:00.000Z",
        actor: {
          providerNodeId: "reviewer-node",
          login: "reviewer",
          avatarUrl: null,
          profileUrl: null,
        },
        url: null,
        state: "approved",
        body: "Review **body**",
        commitOid: null,
      },
    ];

    render(<PullRequestTimeline items={items} />);

    const timeline = screen.getByRole("list", { name: "Pull request timeline" });
    const rows = within(timeline).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.providerNodeId)).toEqual([
      "node-a",
      "node-b",
      "node-z",
    ]);
    rows.forEach((row, index) => {
      expect(row).toHaveAttribute("aria-posinset", String(index + 1));
      expect(row).toHaveAttribute("aria-setsize", "3");
      expect(row.querySelector("time[datetime]")).not.toBeNull();
    });
    expect(
      await within(timeline).findByText("body", {}, { timeout: 12_000 }),
    ).toBeVisible();
    expect(await within(timeline).findByText("Later body")).toBeVisible();
  }, 15_000);

  it("shows older, newer-gap, bounded, and stale states through callback seams", async () => {
    const user = userEvent.setup();
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();
    render(
      <PullRequestTimeline
        items={[
          opened("node-a", "2026-07-11T12:00:00.000Z"),
          opened("node-b", "2026-07-11T12:01:00.000Z"),
        ]}
        hasMoreOlder
        hasMoreNewer
        stale
        boundedData={{ reason: "catch_up_limit" }}
        onLoadOlder={onLoadOlder}
        onLoadNewer={onLoadNewer}
      />,
    );

    expect(screen.getByText("Stale data. Showing the last successful Timeline.")).toBeVisible();
    expect(screen.getByText("Newer activity remains.")).toBeVisible();
    expect(screen.getByText("Refresh limit reached. Newer remote activity remains.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(onLoadOlder).toHaveBeenCalledWith({
      providerNodeId: "node-a",
      offsetTop: 0,
    });
    await user.click(screen.getByRole("button", { name: "Load newer activity" }));
    expect(onLoadNewer).toHaveBeenCalledOnce();
  });

  it("connects event markers as one continuous activity rail", () => {
    render(
      <PullRequestTimeline
        items={[
          opened("node-a", "2026-07-11T12:00:00.000Z"),
          opened("node-b", "2026-07-11T12:01:00.000Z"),
          opened("node-c", "2026-07-11T12:02:00.000Z"),
        ]}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[data-timeline-connector="before"]')).toBeNull();
    expect(rows[0]?.querySelector('[data-timeline-connector="after"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-timeline-connector="before"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-timeline-connector="after"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-timeline-connector="before"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-timeline-connector="after"]')).toBeNull();
    rows.forEach((row) => {
      expect(row.querySelector('[data-timeline-marker="opened"]')).not.toBeNull();
    });
  });

  it("uses the rounded comment bubble for comment activity", () => {
    render(
      <PullRequestTimeline
        items={[
          {
            kind: "issue_comment",
            providerNodeId: "comment-node",
            occurredAt: "2026-07-11T12:00:00.000Z",
            updatedAt: "2026-07-11T12:00:00.000Z",
            actor: null,
            url: null,
            body: "Comment body",
          },
        ]}
      />,
    );

    expect(
      document.querySelector(
        '[data-timeline-marker="issue_comment"] svg.lucide-message-circle',
      ),
    ).not.toBeNull();
  });

  it("distinguishes initial loading, failed-empty, and successful-empty states", () => {
    const view = render(<PullRequestTimeline items={[]} initialLoading />);

    expect(screen.getByText("Loading Timeline activity")).toBeVisible();
    expect(screen.queryByText("No remote activity")).not.toBeInTheDocument();

    view.rerender(<PullRequestTimeline items={[]} initialFailed />);
    expect(screen.getByText("Timeline activity is unavailable.")).toBeVisible();
    expect(screen.queryByText("No remote activity")).not.toBeInTheDocument();

    view.rerender(<PullRequestTimeline items={[]} />);
    expect(screen.getByText("No remote activity")).toBeVisible();
  });

  it("defers variable-row reads to ResizeObserver with overscan four", () => {
    const items = Array.from({ length: 1_000 }, (_, index) =>
      opened(
        `node-${index.toString().padStart(4, "0")}`,
        new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      ),
    );

    render(<PullRequestTimeline items={items} />);

    const options = virtualizerProbe.options.at(-1);
    expect(options).toMatchObject({ count: 1_000, overscan: 4 });
    expect(options?.getItemKey(0)).toBe("node-0000");
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveAttribute("aria-posinset", "1");
    expect(rows[0]).toHaveAttribute("aria-setsize", "1000");
    expect(virtualizerProbe.measureElement).toHaveBeenCalled();
    const element = document.createElement("li");
    const offsetHeight = vi.spyOn(element, "offsetHeight", "get");
    expect(options?.measureElement(element, undefined, {})).toBe(70);
    expect(offsetHeight).not.toHaveBeenCalled();
    expect(options?.measureElement(
      element,
      {
        borderBoxSize: [{ blockSize: 163.4, inlineSize: 500 }],
      } as unknown as ResizeObserverEntry,
      {},
    )).toBe(163);
  });

  it.each([
    "https://user:secret@example.com/review",
    "javascript:alert(1)",
    "/owner/repository/pull/42#event",
  ])("omits unsafe remote event URL %s", (url) => {
    render(
      <PullRequestTimeline
        items={[{ ...opened("node-a", "2026-07-11T12:00:00.000Z"), url }]}
      />,
    );

    expect(screen.queryByRole("link", { name: "Open event" })).not.toBeInTheDocument();
  });

  it("keeps final prepend-anchor drift within two pixels after height corrections", async () => {
    const user = userEvent.setup();
    let resolveOlder: (() => void) | undefined;
    const onLoadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOlder = resolve;
        }),
    );
    const initialItems = [
      opened("node-a", "2026-07-11T12:00:00.000Z"),
      opened("node-b", "2026-07-11T12:01:00.000Z"),
    ];
    const { rerender } = render(
      <PullRequestTimeline items={initialItems} hasMoreOlder onLoadOlder={onLoadOlder} />,
    );
    const viewport = screen.getByTestId("timeline-viewport");
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 10, writable: true });
    viewport.getBoundingClientRect = () => bounds(100);
    const firstRow = viewport.querySelector<HTMLElement>(
      '[data-provider-node-id="node-a"]',
    );
    expect(firstRow).not.toBeNull();
    if (!firstRow) return;
    firstRow.getBoundingClientRect = () => bounds(120);

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(onLoadOlder).toHaveBeenCalledWith({ providerNodeId: "node-a", offsetTop: 20 });

    rerender(
      <PullRequestTimeline
        items={[
          opened("node-older", "2026-07-11T11:59:00.000Z"),
          ...initialItems,
        ]}
        hasMoreOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    const anchoredRow = viewport.querySelector<HTMLElement>(
      '[data-provider-node-id="node-a"]',
    );
    expect(anchoredRow).not.toBeNull();
    if (!anchoredRow) return;
    let anchoredContentTop = 160;
    anchoredRow.getBoundingClientRect = () =>
      bounds(anchoredContentTop - viewport.scrollTop);
    const frameQueue: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameQueue.push(callback);
        return frameQueue.length;
      });

    await act(async () => {
      resolveOlder?.();
      await Promise.resolve();
    });

    expect(frameQueue.length).toBeGreaterThanOrEqual(1);
    const initialReadFrames = frameQueue.length;
    for (let index = 0; index < initialReadFrames; index += 1) {
      await act(async () => {
        frameQueue.shift()?.(index);
      });
    }
    expect(viewport.scrollTop).toBe(10);
    expect(frameQueue.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      frameQueue.shift()?.(initialReadFrames);
    });
    expect(viewport.scrollTop).toBe(40);

    anchoredContentTop += 7;
    let frameCount = 0;
    while (frameQueue.length > 0 && frameCount < 20) {
      await act(async () => {
        frameQueue.shift()?.(frameCount + 2);
      });
      frameCount += 1;
    }

    const finalOffset = anchoredRow.getBoundingClientRect().top - bounds(100).top;
    expect(Math.abs(finalOffset - 20)).toBeLessThanOrEqual(2);
    expect(frameQueue).toHaveLength(0);
    requestAnimationFrameSpy.mockRestore();
  });

  it("scrolls a virtualized prepend anchor into the mounted range before correction", async () => {
    const user = userEvent.setup();
    let resolveOlder: (() => void) | undefined;
    const onLoadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOlder = resolve;
        }),
    );
    const currentItems = Array.from({ length: 40 }, (_, index) =>
      opened(
        `node-current-${index.toString().padStart(2, "0")}`,
        new Date(Date.UTC(2026, 6, 11, 12, 0, index)).toISOString(),
      ),
    );
    const olderItems = Array.from({ length: 35 }, (_, index) =>
      opened(
        `node-older-${index.toString().padStart(2, "0")}`,
        new Date(Date.UTC(2026, 6, 11, 11, 0, index)).toISOString(),
      ),
    );
    const view = render(
      <PullRequestTimeline items={currentItems} hasMoreOlder onLoadOlder={onLoadOlder} />,
    );

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    view.rerender(
      <PullRequestTimeline
        items={[...olderItems, ...currentItems]}
        hasMoreOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(
      screen
        .getByTestId("timeline-viewport")
        .querySelector('[data-provider-node-id="node-current-00"]'),
    ).toBeNull();
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);

    await act(async () => {
      resolveOlder?.();
      await Promise.resolve();
    });

    expect(virtualizerProbe.scrollToIndex).toHaveBeenCalledWith(35, {
      align: "start",
    });
    requestAnimationFrameSpy.mockRestore();
  });

  it("rerenders only the Timeline row whose stable item reference changed", () => {
    const first = opened("node-a", "2026-07-11T12:00:00.000Z");
    const second = opened("node-b", "2026-07-11T12:01:00.000Z");
    const view = render(<PullRequestTimeline items={[first, second]} />);
    const firstBefore = formatProbe.calls.get(first.occurredAt) ?? 0;
    const secondBefore = formatProbe.calls.get(second.occurredAt) ?? 0;

    view.rerender(
      <PullRequestTimeline
        items={[
          {
            ...first,
            actor: {
              providerNodeId: "U_one",
              login: "one",
              avatarUrl: null,
              profileUrl: null,
            },
          },
          second,
        ]}
      />,
    );

    expect(formatProbe.calls.get(first.occurredAt)).toBe(firstBefore + 1);
    expect(formatProbe.calls.get(second.occurredAt)).toBe(secondBefore);
  });
});
