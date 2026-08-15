import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeltaBlock } from "../DeltaBlock";

vi.mock("@/components/chat/MarkdownContent", () => ({
  __esModule: true,
  default: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown-content" data-streaming={String(isStreaming)}>
      {content}
    </div>
  ),
}));

function makeRectList(rect: Partial<DOMRect>): DOMRectList {
  const item = {
    right: rect.right ?? 12,
    top: rect.top ?? 4,
    height: rect.height ?? 16,
  } as DOMRect;
  return {
    0: item,
    length: 1,
    item: (index: number) => (index === 0 ? item : null),
    [Symbol.iterator]: function* () {
      yield item;
    },
  } as DOMRectList;
}

describe("DeltaBlock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses plain pre-wrapped text while streaming", () => {
    const { container } = render(
      <DeltaBlock text={"streaming text ".repeat(10)} isStreaming showCursor={false} />,
    );

    expect(screen.queryByTestId("markdown-content")).toBeNull();
    expect(container.querySelector("p.whitespace-pre-wrap")?.textContent).toContain(
      "streaming text",
    );
  });

  it("uses the markdown adapter after settling", async () => {
    render(<DeltaBlock text="**settled**" isStreaming={false} showCursor={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("markdown-content").textContent).toBe("**settled**");
      expect(screen.getByTestId("markdown-content").getAttribute("data-streaming")).toBe("false");
    });
  });

  it("does not re-measure the cursor when displayed text is unchanged", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const range = {
      setStart: vi.fn(),
      setEnd: vi.fn(),
      getClientRects: vi.fn(() => makeRectList({ right: 12, top: 4, height: 16 })),
    } as unknown as Range;
    const createRange = vi.spyOn(document, "createRange").mockReturnValue(range);

    const text = "x".repeat(140);
    const { rerender } = render(<DeltaBlock text={text} isStreaming showCursor />);
    const firstMeasureCount = createRange.mock.calls.length;

    rerender(<DeltaBlock text={text} isStreaming showCursor />);

    expect(firstMeasureCount).toBeGreaterThan(0);
    expect(createRange).toHaveBeenCalledTimes(firstMeasureCount);
  });
});
