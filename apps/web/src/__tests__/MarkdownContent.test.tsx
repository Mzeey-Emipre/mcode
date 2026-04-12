import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownContent } from "../components/chat/MarkdownContent";

// Mock CodeBlock to avoid shiki/worker dependencies
vi.mock("../components/chat/CodeBlock", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

describe("MarkdownContent link handling", () => {
  let mockOpenExternalUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOpenExternalUrl = vi.fn();
    window.desktopBridge = {
      openExternalUrl: mockOpenExternalUrl,
    } as unknown as typeof window.desktopBridge;
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

  it("falls back to window.open when desktopBridge is unavailable", () => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    render(<MarkdownContent content="[link](https://example.com)" />);
    fireEvent.click(screen.getByText("link"));
    expect(mockOpen).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");

    vi.unstubAllGlobals();
  });
});
