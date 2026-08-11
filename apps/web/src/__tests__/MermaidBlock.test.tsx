import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Mock mermaid
const mockRender = vi.fn();
const mockInitialize = vi.fn();
const mockParse = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
    parse: (...args: unknown[]) => mockParse(...args),
  },
}));

// Mock useTheme
vi.mock("../hooks/useTheme", () => ({
  useShikiTheme: vi.fn(() => "github-dark"),
}));

// CodeBlock is no longer used by MermaidBlock (code view renders pre directly)

import MermaidBlock, { __resetForTesting } from "../components/chat/MermaidBlock";

describe("MermaidBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTesting();
    mockRender.mockResolvedValue({ svg: '<svg class="mermaid">diagram</svg>' });
    mockParse.mockResolvedValue({ diagramType: "graph" });
  });

  it("renders raw code when streaming", () => {
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={true} />);
    expect(screen.getByText("graph TD; A-->B;")).toBeInTheDocument();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("renders nothing for empty code", () => {
    const { container } = render(<MermaidBlock code="   " isStreaming={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("calls mermaid.render when not streaming", async () => {
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);
    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledWith(
        expect.stringMatching(/mermaid-.*-\d+$/),
        "graph TD; A-->B;",
      );
    });
  });

  it("renders SVG output after mermaid.render resolves", async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg">test</svg>' });
    const { container } = render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='mermaid-svg']")).toBeInTheDocument();
    });
  });

  it("opens an interactive diagram preview with zoom controls", async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg">test</svg>' });
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);

    const previewTrigger = await screen.findByRole("button", {
      name: "Open diagram preview",
    });
    fireEvent.click(previewTrigger);

    expect(await screen.findByRole("dialog")).toHaveClass("app-viewport-fixed");
    expect(screen.getByRole("heading", { name: "Diagram preview" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset view" })).toBeEnabled();
    expect(screen.getByText("100%")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(screen.getByText("100%")).toBeVisible();

    const canvas = screen.getByRole("application", {
      name: "Interactive diagram canvas",
    });
    Object.assign(canvas, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(canvas, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });

    expect(canvas.querySelector("[style*='translate3d']")).toHaveStyle({
      transform: "translate3d(20px, 30px, 0) scale(1)",
    });
  });

  it("shows error banner and raw code on render failure", async () => {
    mockRender.mockRejectedValue(new Error("Parse error"));
    render(<MermaidBlock code="invalid mermaid" isStreaming={false} />);
    await waitFor(() => {
      expect(screen.getByText(/diagram could not be rendered/i)).toBeInTheDocument();
      expect(screen.getByText("invalid mermaid")).toBeInTheDocument();
    });
  });

  it("initializes mermaid with securityLevel strict", async () => {
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);
    await waitFor(() => {
      expect(mockInitialize).toHaveBeenCalledWith(
        expect.objectContaining({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
        }),
      );
    });
  });

  it("toggles between diagram and code view", async () => {
    mockRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /view code/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /view code/i }));
    expect(screen.getByText("graph TD; A-->B;")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /view diagram/i }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /view diagram/i })).not.toBeInTheDocument();
    });
  });

  it("copy button copies raw mermaid source", async () => {
    mockRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("graph TD; A-->B;");
    });
  });

  it("skips render and shows error banner when parse reports invalid source", async () => {
    // parse returns false when suppressErrors is passed and source is invalid
    mockParse.mockResolvedValue(false);

    render(<MermaidBlock code="not valid mermaid" isStreaming={false} />);

    await waitFor(() => {
      expect(screen.getByText(/diagram could not be rendered/i)).toBeInTheDocument();
    });

    expect(mockRender).not.toHaveBeenCalled();
    // No orphan nodes appended to document.body by MermaidBlock.
    expect(document.body.querySelector("[id^='mermaid-']")).toBeNull();
    expect(document.body.querySelector("[id^='dmermaid-']")).toBeNull();
  });

  it("removes orphan measurement node when render throws after a successful parse", async () => {
    mockParse.mockResolvedValue({ diagramType: "graph" });
    mockRender.mockImplementation(async (id: string) => {
      // Simulate mermaid's internal measurement node left on <body> after a render-time failure.
      const orphan = document.createElement("div");
      orphan.id = "d" + id;
      orphan.setAttribute("data-testid", "mermaid-orphan");
      document.body.appendChild(orphan);
      throw new Error("Render exploded");
    });

    render(<MermaidBlock code="graph TD; A-->B;" isStreaming={false} />);

    await waitFor(() => {
      expect(screen.getByText(/diagram could not be rendered/i)).toBeInTheDocument();
    });

    // Orphan must be gone after the error is handled.
    expect(document.body.querySelector("[data-testid='mermaid-orphan']")).toBeNull();
  });

  it("ignores stale render results when code changes before the prior render resolves", async () => {
    let resolveFirst!: (value: { svg: string }) => void;
    const firstRender = new Promise<{ svg: string }>((resolve) => {
      resolveFirst = resolve;
    });
    mockRender
      .mockReturnValueOnce(firstRender)
      .mockResolvedValueOnce({ svg: "<svg>second</svg>" });

    const { container, rerender } = render(
      <MermaidBlock code="graph TD; A-->B;" isStreaming={false} />,
    );

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledTimes(1);
    });

    rerender(<MermaidBlock code="graph TD; X-->Y;" isStreaming={false} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledTimes(2);
    });

    resolveFirst({ svg: "<svg>stale</svg>" });

    await waitFor(() => {
      expect(container.querySelector("svg")).toBeInTheDocument();
    });
    expect(container.innerHTML).toContain("second");
    expect(container.innerHTML).not.toContain("stale");
  });
});
