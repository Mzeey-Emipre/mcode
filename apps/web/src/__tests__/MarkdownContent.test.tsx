import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MarkdownContent } from "../components/chat/MarkdownContent";
import { CodeBlock } from "../components/chat/CodeBlock";

// Mock CodeBlock to avoid shiki/worker dependencies
vi.mock("../components/chat/MermaidBlock", () => ({
  default: ({ code, isStreaming }: { code: string; isStreaming: boolean }) => (
    <div data-testid="mermaid-block" data-streaming={String(isStreaming)}>{code}</div>
  ),
}));

vi.mock("../components/chat/CodeBlock", () => ({
  CodeBlock: vi.fn(({ code, language, disableHighlighting, isStreaming }: {
    code: string;
    language: string;
    disableHighlighting?: boolean;
    isStreaming?: boolean;
  }) => (
    <pre data-testid="code-block" data-language={language} data-disable-highlighting={String(disableHighlighting)}>
      {code}
    </pre>
  )),
}));

const mockCodeBlock = vi.mocked(CodeBlock);

describe("MarkdownContent link handling", () => {
  let mockOpenExternalUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOpenExternalUrl = vi.fn();
    window.desktopBridge = {
      openExternalUrl: mockOpenExternalUrl,
    } as unknown as typeof window.desktopBridge;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    vi.unstubAllGlobals();
  });

  it("calls desktopBridge.openExternalUrl for https links", () => {
    render(<MarkdownContent content="[click me](https://example.com)" />);
    const link = screen.getByText("click me");
    fireEvent.click(link);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("calls desktopBridge.openExternalUrl for http links", () => {
    render(<MarkdownContent content="[click](http://example.com)" />);
    const link = screen.getByText("click");
    fireEvent.click(link);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith("http://example.com");
  });

  it("calls desktopBridge.openExternalUrl for mailto links", () => {
    render(<MarkdownContent content="[email](mailto:test@example.com)" />);
    const link = screen.getByText("email");
    fireEvent.click(link);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith("mailto:test@example.com");
  });

  it("does not call desktopBridge for javascript: links", () => {
    render(<MarkdownContent content='[xss](javascript:alert(1))' />);
    const link = screen.getByText("xss");
    fireEvent.click(link);
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it("does not call desktopBridge for data: URI links", () => {
    render(<MarkdownContent content='[data](data:text/html,<h1>hi</h1>)' />);
    const link = screen.getByText("data");
    fireEvent.click(link);
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it("falls back to window.open when desktopBridge is unavailable", () => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    render(<MarkdownContent content="[link](https://example.com)" />);
    fireEvent.click(screen.getByText("link"));
    expect(mockOpen).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
  });
});

describe("MarkdownContent variant styling", () => {
  beforeEach(() => {
    mockCodeBlock.mockClear();
  });

  describe("variant='assistant' (default)", () => {
    it("renders inline code with bg-muted", () => {
      const { container } = render(
        <MarkdownContent content="Use `foo` here" />,
      );
      const code = container.querySelector("code");
      expect(code?.className).toContain("bg-muted");
    });

    it("renders links with text-primary", () => {
      const { container } = render(
        <MarkdownContent content="[link](https://example.com)" />,
      );
      const link = container.querySelector("a");
      expect(link?.className).toContain("text-primary");
    });

    it("passes disableHighlighting=false to CodeBlock", () => {
      render(<MarkdownContent content={'```ts\nconst x = 1;\n```'} />);
      expect(mockCodeBlock).toHaveBeenCalledWith(
        expect.objectContaining({ disableHighlighting: false, isStreaming: false }),
        undefined,
      );
    });
  });

  describe("variant='user'", () => {
    it("renders inline code with bg-primary-foreground/15", () => {
      const { container } = render(
        <MarkdownContent content="Use `foo` here" variant="user" />,
      );
      const code = container.querySelector("code");
      expect(code?.className).toContain("bg-primary-foreground/15");
    });

    it("renders links with text-primary-foreground", () => {
      const { container } = render(
        <MarkdownContent content="[link](https://example.com)" variant="user" />,
      );
      const link = container.querySelector("a");
      expect(link?.className).toContain("text-primary-foreground");
    });

    it("renders blockquote with border-primary-foreground/40", () => {
      const { container } = render(
        <MarkdownContent content="> quote" variant="user" />,
      );
      const blockquote = container.querySelector("blockquote");
      expect(blockquote?.className).toContain("border-primary-foreground/40");
    });

    it("passes disableHighlighting=true to CodeBlock", () => {
      render(<MarkdownContent content={'```ts\nconst x = 1;\n```'} variant="user" />);
      expect(mockCodeBlock).toHaveBeenCalledWith(
        expect.objectContaining({ disableHighlighting: true, isStreaming: false }),
        undefined,
      );
    });
  });
});

describe("mermaid code blocks", () => {
  it("routes mermaid language to MermaidBlock", async () => {
    render(
      <MarkdownContent content={'```mermaid\ngraph TD; A-->B;\n```'} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-block")).toBeInTheDocument();
      expect(screen.getByTestId("mermaid-block")).toHaveTextContent("graph TD; A-->B;");
    });
  });

  it("passes isStreaming to MermaidBlock", async () => {
    render(
      <MarkdownContent content={'```mermaid\ngraph TD;\n```'} isStreaming={true} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-block")).toHaveAttribute("data-streaming", "true");
    });
  });

  it("routes non-mermaid languages to CodeBlock", () => {
    render(
      <MarkdownContent content={'```python\nprint("hi")\n```'} />,
    );
    expect(screen.getByTestId("code-block")).toBeInTheDocument();
    expect(screen.queryByTestId("mermaid-block")).not.toBeInTheDocument();
  });

  it("routes mermaid to MermaidBlock in user variant too", async () => {
    render(
      <MarkdownContent content={'```mermaid\ngraph LR; X-->Y;\n```'} variant="user" />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-block")).toBeInTheDocument();
    });
  });
});
