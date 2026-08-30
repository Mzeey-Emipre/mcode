import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MarkdownContent } from "../components/chat/MarkdownContent";
import { CodeBlock } from "../components/chat/CodeBlock";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "../stores/diffStore";
import { createMockWorkspace, createMockThread } from "./mocks/transport";

// Mock CodeBlock to avoid shiki/worker dependencies
vi.mock("../components/chat/MermaidBlock", () => ({
  default: ({ code, isStreaming }: { code: string; isStreaming: boolean }) => (
    <div data-testid="mermaid-block" data-streaming={String(isStreaming)}>{code}</div>
  ),
}));

vi.mock("../components/chat/CodeBlock", () => ({
  CodeBlock: vi.fn(({ code, language, languageLabel, disableHighlighting, isStreaming, chatHighlighting }: {
    code: string;
    language: string;
    languageLabel?: string;
    disableHighlighting?: boolean;
    isStreaming?: boolean;
    chatHighlighting?: boolean;
  }) => (
    <pre
      data-testid="code-block"
      data-language={language}
      data-language-label={languageLabel ?? ""}
      data-disable-highlighting={String(disableHighlighting)}
      data-streaming={String(isStreaming)}
      data-chat-highlighting={String(chatHighlighting)}
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

  it("renders assistant https links with a contrast-safe favicon", () => {
    const { container } = render(<MarkdownContent content="[click me](https://example.com/path)" />);
    const link = container.querySelector("a");
    const favicon = screen.getByTestId("markdown-link-favicon");

    expect(link).toHaveClass("text-primary");
    expect(link).not.toHaveClass("text-link");
    expect(screen.getByTestId("markdown-link-favicon-frame")).toBeInTheDocument();
    expect(favicon).toHaveAttribute("src", "https://example.com/favicon.ico");
    expect(favicon).toHaveClass("favicon-image-shadow");
  });

  it("renders inline links without a chip background", () => {
    const { container } = render(<MarkdownContent content="[click me](https://example.com)" />);
    const link = container.querySelector("a");

    expect(link?.className).not.toContain("bg-muted");
    expect(link?.className).not.toContain("ring-1");
    expect(link?.className).toContain("hover:underline");
  });

  it("renders GitHub links with the bare themed mark, not the contrast frame", () => {
    render(<MarkdownContent content="[repo](https://github.com/owner/repo)" />);
    const favicon = screen.getByTestId("markdown-link-favicon");

    expect(favicon).toHaveClass("github-favicon-mark");
    expect(favicon).not.toHaveClass("favicon-image-shadow");
    expect(screen.getByTestId("markdown-link-favicon-frame").className).not.toContain("ring-1");
  });

  it("renders local file links with the file icon component, not a site favicon", () => {
    render(<MarkdownContent content="[local-unseeded-app.png](/tmp/screens/local-unseeded-app.png)" />);

    expect(screen.getByTestId("markdown-link-file-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-link-favicon-frame")).not.toBeInTheDocument();
  });

  it("shows a bare GitHub repo URL as owner/repo but opens the full URL", () => {
    render(<MarkdownContent content="https://github.com/milex-consulting/CaravanFE" />);
    const link = screen.getByText("milex-consulting/CaravanFE");

    expect(link.closest("a")).toHaveAttribute("title", "https://github.com/milex-consulting/CaravanFE");
    fireEvent.click(link);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith("https://github.com/milex-consulting/CaravanFE");
  });

  it("shows a bare GitHub issue URL as owner/repo#number", () => {
    render(<MarkdownContent content="https://github.com/milex-consulting/CaravanFE/issues/42" />);
    expect(screen.getByText("milex-consulting/CaravanFE#42")).toBeInTheDocument();
  });

  it("compacts a bare non-GitHub URL to host/path, dropping the protocol", () => {
    render(<MarkdownContent content="https://www.example.com/docs/start/" />);
    expect(screen.getByText("example.com/docs/start")).toBeInTheDocument();
  });

  it("never rewrites authored link text", () => {
    render(<MarkdownContent content="[the repo](https://github.com/milex-consulting/CaravanFE)" />);
    expect(screen.getByText("the repo")).toBeInTheDocument();
    expect(screen.queryByText("milex-consulting/CaravanFE")).not.toBeInTheDocument();
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
  let mockResolveNavigation: ReturnType<typeof vi.fn>;
  let mockOpen: ReturnType<typeof vi.fn>;
  let showRightPanel: ReturnType<typeof vi.fn>;
  let setRightPanelTab: ReturnType<typeof vi.fn>;
  let setPreviewUrlForThread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockNavigate = vi.fn().mockResolvedValue({ ok: true });
    mockResolveNavigation = vi.fn(async (url: string) => ({ ok: true, url }));
    mockOpen = vi.fn().mockResolvedValue({ ok: true, data: { tabId: "tab-2", tabs: {} } });
    showRightPanel = vi.fn();
    setRightPanelTab = vi.fn();
    setPreviewUrlForThread = vi.fn();
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
      setPreviewUrlForThread,
    } as Partial<ReturnType<typeof useDiffStore.getState>>);
    window.desktopBridge = {
      openExternalUrl: vi.fn(),
      preview: {
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
        tabs: {
          open: mockOpen,
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
    expect(screen.getByTestId("markdown-link-file-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-link-favicon-frame")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(link!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(showRightPanel).toHaveBeenCalledWith("ws-prev", "thread-prev");
    expect(setRightPanelTab).toHaveBeenCalledWith("ws-prev", "thread-prev", "preview");
    expect(mockResolveNavigation).toHaveBeenCalledWith(
      "mcode-workspace:///sub/page.html",
      "/tmp/ws-preview-test",
    );
    expect(mockOpen).toHaveBeenCalledWith("thread-prev", "ws-prev", {
      activate: true,
      initialAddress: "mcode-workspace:///sub/page.html",
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-prev", "mcode-workspace:///sub/page.html");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("rewrites relative html link to mcode-workspace for navigation", async () => {
    const { container } = render(<MarkdownContent content="[doc](./sub/page.html)" />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    await act(async () => {
      fireEvent.click(link!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(mockOpen).toHaveBeenCalledWith("thread-prev", "ws-prev", {
      activate: true,
      initialAddress: "mcode-workspace:///sub/page.html",
    });
    expect(mockResolveNavigation).toHaveBeenCalledWith(
      "mcode-workspace:///sub/page.html",
      "/tmp/ws-preview-test",
    );
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-prev", "mcode-workspace:///sub/page.html");
    expect(mockNavigate).not.toHaveBeenCalled();
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
    expect(mockOpen).toHaveBeenCalledWith("thread-prev", "ws-prev", {
      activate: true,
      initialAddress: "mcode-workspace:///report.html",
    });
    expect(mockResolveNavigation).toHaveBeenCalledWith(
      "mcode-workspace:///report.html",
      "/tmp/ws-preview-test",
    );
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-prev", "mcode-workspace:///report.html");
    expect(mockNavigate).not.toHaveBeenCalled();
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
        resolveNavigation: mockResolveNavigation,
        tabs: {
          open: mockOpen,
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
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith(
      "thread-prev",
      "mcode-workspace:///page.html",
    );
  });

  it("binds a ctrl+click URL to the existing blank preview tab", async () => {
    window.desktopBridge = {
      openExternalUrl: vi.fn(),
      preview: {
        resolveNavigation: mockResolveNavigation,
        tabs: {
          open: mockOpen,
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

    const { container } = render(<MarkdownContent content="[doc](https://example.com/page)" />);
    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    await act(async () => {
      fireEvent.click(link!, { ctrlKey: true });
      await vi.runAllTimersAsync();
    });

    expect(mockOpen).toHaveBeenCalledWith("thread-prev", "ws-prev", {
      activate: true,
      tabId: "tab-1",
      initialAddress: "https://example.com/page",
    });
  });

  it("stores the resolved URL without calling retired navigation", async () => {
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
    expect(mockNavigate).not.toHaveBeenCalled();
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

    it("renders explicit skill, plugin, command, and sub-agent references as entity tokens", () => {
      const { container } = render(
        <MarkdownContent content="Use `$impeccable`, `plugin:figma`, `/review`, and `@reviewer_qa`." />,
      );

      expect(container.querySelector('[data-entity-token="skill"]')).toHaveTextContent("$impeccable");
      expect(container.querySelector('[data-entity-token="plugin"]')).toHaveTextContent("plugin:figma");
      expect(container.querySelector('[data-entity-token="command"]')).toHaveTextContent("review");
      expect(container.querySelector('[data-entity-token="agent"]')).toHaveTextContent("@reviewer_qa");
    });

    it("renders command references as inline invocations, not chips", () => {
      const { container } = render(<MarkdownContent content="Run `/review` after the changes." />);
      const command = container.querySelector('[data-entity-token="command"]');

      expect(command).toHaveTextContent("review");
      expect(command).toHaveClass("text-primary");
      expect(command).not.toHaveClass("bg-muted", "ring-1", "rounded-md");
      expect(command?.querySelector("[data-entity-icon='command']")).toHaveClass("text-current");
    });

    it("renders links with primary text", () => {
      const { container } = render(
        <MarkdownContent content="[link](https://example.com)" />,
      );
      const link = container.querySelector("a");
      expect(link).toHaveClass("text-primary");
      expect(link).not.toHaveClass("text-link");
    });

    it("passes disableHighlighting=false to CodeBlock", () => {
      render(<MarkdownContent content={'```ts\nconst x = 1;\n```'} />);
      expect(mockCodeBlock).toHaveBeenCalledWith(
        expect.objectContaining({ disableHighlighting: false, isStreaming: false, chatHighlighting: false }),
        undefined,
      );
    });

    it("does not schedule non-chat Markdown through the chat coordinator", () => {
      render(<MarkdownContent content={'```ts\nconst x = 1;\n```'} />);
      expect(mockCodeBlock).toHaveBeenCalledWith(
        expect.objectContaining({ chatHighlighting: false }),
        undefined,
      );
    });
  });

  describe("variant='user'", () => {
    it("renders inline code with a foreground tint visible on the accent bubble", () => {
      const { container } = render(
        <MarkdownContent content="Use `foo` here" variant="user" />,
      );
      const code = container.querySelector("code");
      expect(code?.className).toContain("bg-foreground/10");
    });

    it("renders links with primary text", () => {
      const { container } = render(
        <MarkdownContent content="[link](https://example.com)" variant="user" />,
      );
      const link = container.querySelector("a");
      expect(link).toHaveClass("text-primary");
      expect(link).not.toHaveClass("text-link");
    });

    it("renders user links with the same favicon treatment", () => {
      render(<MarkdownContent content="[link](https://example.com)" variant="user" />);
      expect(screen.getByTestId("markdown-link-favicon-frame")).toBeInTheDocument();
      expect(screen.getByTestId("markdown-link-favicon")).toHaveAttribute(
        "src",
        "https://example.com/favicon.ico",
      );
    });

    it("renders blockquote with the neutral border treatment", () => {
      const { container } = render(
        <MarkdownContent content="> quote" variant="user" />,
      );
      const blockquote = container.querySelector("blockquote");
      expect(blockquote?.className).toContain("border-border");
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
