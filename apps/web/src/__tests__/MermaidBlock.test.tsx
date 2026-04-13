import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Mock mermaid
const mockRender = vi.fn();
const mockInitialize = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

// Mock useTheme
vi.mock("../hooks/useTheme", () => ({
  useShikiTheme: vi.fn(() => "github-dark"),
}));

// Mock CodeBlock
vi.mock("../components/chat/CodeBlock", () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) => (
    <pre data-testid="code-block" data-language={language}>{code}</pre>
  ),
}));

import MermaidBlock, { __resetForTesting } from "../components/chat/MermaidBlock";

describe("MermaidBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTesting();
    mockRender.mockResolvedValue({ svg: '<svg class="mermaid">diagram</svg>' });
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
        expect.stringContaining("mermaid-"),
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

  it("falls back to CodeBlock with error banner on render failure", async () => {
    mockRender.mockRejectedValue(new Error("Parse error"));
    render(<MermaidBlock code="invalid mermaid" isStreaming={false} />);
    await waitFor(() => {
      expect(screen.getByText(/diagram could not be rendered/i)).toBeInTheDocument();
      expect(screen.getByTestId("code-block")).toBeInTheDocument();
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
    expect(screen.getByTestId("code-block")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /view diagram/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("code-block")).not.toBeInTheDocument();
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
});
