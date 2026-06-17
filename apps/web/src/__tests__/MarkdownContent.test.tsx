import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MarkdownContent } from "../components/chat/MarkdownContent";
import { CodeBlock } from "../components/chat/CodeBlock";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useDiffStore } from "../stores/diffStore";
import { createMockWorkspace, createMockThread } from "./mocks/transport";

// Mock CodeBlock to avoid shiki/worker dependencies
vi.mock("../components/chat/MermaidBlock", () => ({
  default: ({ code, isStreaming }: { code: string; isStreaming: boolean }) => (
    <div data-testid="mermaid-block" data-streaming={String(isStreaming)}>{code}</div>
  ),
}));

vi.mock("../components/chat/CodeBlock", () => ({
  CodeBlock: vi.fn(({ code, language, languageLabel, disableHighlighting, isStreaming }: {
    code: string;
    language: string;
    languageLabel?: string;
    disableHighlighting?: boolean;
    isStreaming?: boolean;
  }) => (
    <pre
      data-testid="code-block"
      data-language={language}
      data-language-label={languageLabel ?? ""}
      data-disable-highlighting={String(disableHighlighting)}
      data-streaming={String(isStreaming)}
    >
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

describe("MarkdownContent workspace preview navigation", () => {
  let mockNavigate: ReturnType<typeof vi.fn>;
  let mockCreate: ReturnType<typeof vi.fn>;
  let showRightPanel: ReturnType<typeof vi.fn>;
  let setRightPanelTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockNavigate = vi.fn().mockResolvedValue({ ok: true });
    mockCreate = vi.fn().mockResolvedValue({ ok: true, data: { tabId: "tab-2", tabs: {} } });
    showRightPanel = vi.fn();
    setRightPanelTab = vi.fn();
    const ws = createMockWorkspace({ id: "ws-prev", path: "/tmp/ws-preview-test" });
    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      activeThreadId: "thread-prev",
      threads: [createMockThread({ id: "thread-prev", workspace_id: ws.id })],
    });
    useDiffStore.setState({
      showRightPanel,
      setRightPanelTab,
      setPreviewUrlForThread: vi.fn(),
    } as Partial<ReturnType<typeof useDiffStore.getState>>);
    window.desktopBridge = {
      openExternalUrl: vi.fn(),
      preview: {
        navigate: mockNavigate,
        tabs: {
          create: mockCreate,
          list: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              threadId: "thread-prev",
              activeTabId: "tab-1",
              tabs: [{
                id: "tab-1",
                threadId: "thread-prev",
                title: "Example",
                url: "https://example.com",
                faviconUrl: null,
                warm: true,
                active: true,
              }],
            },
          }),
        },
      },
    } as unknown as typeof window.desktopBridge;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      activeThreadId: null,
    });
    useDiffStore.setState({ previewUrlByThread: {} });
  });

  it("creates a new preview tab and navigates on ctrl+click", async () => {
    const { container } = render(<MarkdownContent content="[doc](mcode-workspace:///sub/page.html)" />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    await act(async () => {
      fireEvent.click(link!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(showRightPanel).toHaveBeenCalledWith("ws-prev", "thread-prev");
    expect(setRightPanelTab).toHaveBeenCalledWith("ws-prev", "thread-prev", "preview");
    expect(mockCreate).toHaveBeenCalledWith("thread-prev", true);
    expect(mockNavigate).toHaveBeenCalledWith(
      "mcode-workspace:///sub/page.html",
      "/tmp/ws-preview-test",
    );
  });

  it("rewrites relative html link to mcode-workspace for navigation", async () => {
    const { container } = render(<MarkdownContent content="[doc](./sub/page.html)" />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    await act(async () => {
      fireEvent.click(link!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(mockCreate).toHaveBeenCalledWith("thread-prev", true);
    expect(mockNavigate).toHaveBeenCalledWith(
      "mcode-workspace:///sub/page.html",
      "/tmp/ws-preview-test",
    );
  });

  it("opens mcode-workspace in the default browser on plain click", async () => {
    const mockOpenExternal = vi.fn();
    const ws = createMockWorkspace({ id: "ws-plain", path: "/proj/plain" });
    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      activeThreadId: "thread-plain",
    });
    window.desktopBridge = {
      openExternalUrl: mockOpenExternal,
      preview: { navigate: vi.fn() },
    } as unknown as typeof window.desktopBridge;

    const { container } = render(<MarkdownContent content="[doc](mcode-workspace:///page.html)" />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    await act(async () => {
      fireEvent.click(link!);
    });
    expect(mockOpenExternal).toHaveBeenCalledWith("mcode-workspace:///page.html", "/proj/plain");

    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      activeThreadId: null,
    });
    delete (window as unknown as Record<string, unknown>).desktopBridge;
  });

  it("treats inline workspace html path like a previewable shortcut", async () => {
    const { container } = render(<MarkdownContent content="Open `report.html` now" />);
    const el = container.querySelector('[role="link"]');
    expect(el).toBeTruthy();
    await act(async () => {
      fireEvent.click(el!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(mockCreate).toHaveBeenCalledWith("thread-prev", true);
    expect(mockNavigate).toHaveBeenCalledWith(
      "mcode-workspace:///report.html",
      "/tmp/ws-preview-test",
    );
  });

  it("stores URL for preview sync when preview.navigate is missing on ctrl+click", async () => {
    const setPreviewUrlForThread = vi.fn();
    useDiffStore.setState({
      showRightPanel,
      setRightPanelTab,
      setPreviewUrlForThread,
    } as Partial<ReturnType<typeof useDiffStore.getState>>);
    window.desktopBridge = {
      openExternalUrl: vi.fn(),
      preview: {
        tabs: {
          create: mockCreate,
          list: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              threadId: "thread-prev",
              activeTabId: "tab-1",
              tabs: [{
                id: "tab-1",
                threadId: "thread-prev",
                title: null,
                url: null,
                faviconUrl: null,
                warm: true,
                active: true,
              }],
            },
          }),
        },
      },
    } as unknown as typeof window.desktopBridge;

    const { container } = render(<MarkdownContent content="[doc](mcode-workspace:///page.html)" />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    await act(async () => {
      fireEvent.click(link!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith(
      "thread-prev",
      "mcode-workspace:///page.html",
    );
  });

  it("stores URL when navigate rejects on ctrl+click", async () => {
    const setPreviewUrlForThread = vi.fn();
    useDiffStore.setState({
      showRightPanel,
      setRightPanelTab,
      setPreviewUrlForThread,
    } as Partial<ReturnType<typeof useDiffStore.getState>>);
    mockNavigate.mockRejectedValue(new Error("nav failed"));

    const { container } = render(<MarkdownContent content="[doc](https://example.com/x)" />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    await act(async () => {
      fireEvent.click(link!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-prev", "https://example.com/x");
    expect(mockNavigate).toHaveBeenCalled();
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

    it("preserves composer line breaks as visible breaks", () => {
      const { container } = render(
        <MarkdownContent content={"q1 hey\nq2 hello"} variant="user" />,
      );
      expect(container.querySelector("br")).toBeTruthy();
      expect(container.textContent).toContain("q1 hey");
      expect(container.textContent).toContain("q2 hello");
    });
  });
});

describe("MarkdownContent path-based fence language", () => {
  it("resolves GitHub-style start:end:path fences to Shiki language and basename label", () => {
    render(
      <MarkdownContent content={'```1:20:apps/web/foo.ts\nconst a = 1;\n```'} />,
    );
    const block = screen.getByTestId("code-block");
    expect(block).toHaveAttribute("data-language", "typescript");
    expect(block).toHaveAttribute("data-language-label", "foo.ts");
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
