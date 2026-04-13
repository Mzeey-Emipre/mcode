import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CodeBlock } from "../components/chat/CodeBlock";

// Mock useHighlighter to control Worker responses
vi.mock("../hooks/useHighlighter", () => ({
  useHighlighter: vi.fn(() => ({ html: null })),
}));

// Mock useTheme
vi.mock("../hooks/useTheme", () => ({
  useShikiTheme: vi.fn(() => "github-dark"),
}));

import { useHighlighter } from "../hooks/useHighlighter";

const mockUseHighlighter = vi.mocked(useHighlighter);

describe("CodeBlock", () => {
  it("renders plain code as fallback when html is null", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />);
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
  });

  it("shows the language label", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(<CodeBlock code="print('hi')" language="python" isStreaming={false} />);
    expect(screen.getByText("python")).toBeInTheDocument();
  });

  it("renders highlighted html when available", () => {
    mockUseHighlighter.mockReturnValue({
      html: '<pre class="shiki github-dark"><code><span>const x = 1;</span></code></pre>',
    });
    const { container } = render(
      <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />,
    );
    const highlighted = container.querySelector(".shiki");
    expect(highlighted).toBeInTheDocument();
  });

  it("passes enabled=false to useHighlighter when streaming", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(
      <CodeBlock code="const x = 1;" language="typescript" isStreaming={true} />,
    );
    // The hook is called with enabled=false so the Worker is not fired
    expect(mockUseHighlighter).toHaveBeenCalledWith(
      "const x = 1;",
      "typescript",
      "github-dark",
      false,
    );
  });

  it("shows a copy button when not streaming", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />);
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("does not show a copy button when streaming", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={true} />);
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("copies code to clipboard on button click", async () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    try {
      render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />);
      fireEvent.click(screen.getByRole("button", { name: /copy/i }));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("const x = 1;");
      });
    } finally {
      Object.assign(navigator, { clipboard: originalClipboard });
    }
  });

  it("adds ready class when highlighted html is available", () => {
    mockUseHighlighter.mockReturnValue({
      html: '<pre class="shiki"><code>highlighted</code></pre>',
    });
    const { container } = render(
      <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />,
    );
    const wrapper = container.querySelector("[data-code-block]");
    expect(wrapper?.className).toContain("ready");
  });

  it("skips highlighting when disableHighlighting is true", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(
      <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} disableHighlighting />,
    );
    expect(mockUseHighlighter).toHaveBeenCalledWith(
      "const x = 1;",
      "typescript",
      "github-dark",
      false,
    );
  });

  it("still shows copy button when disableHighlighting is true", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(
      <CodeBlock code="const x = 1;" language="typescript" isStreaming={false} disableHighlighting />,
    );
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("still shows language label when disableHighlighting is true", () => {
    mockUseHighlighter.mockReturnValue({ html: null });
    render(
      <CodeBlock code="print('hi')" language="python" isStreaming={false} disableHighlighting />,
    );
    expect(screen.getByText("python")).toBeInTheDocument();
  });
});
