import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { App } from "../app/App";

// Mock the transport module to prevent Tauri initialization errors
vi.mock("@/transport", () => ({
  getTransport: () => ({
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
  }),
}));

// Mock ScrollArea since @base-ui/react may not work in jsdom
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>{children}</div>
  ),
  ScrollBar: () => null,
}));

describe("App", () => {
  it("renders the sidebar with app title", () => {
    render(<App />);
    expect(screen.getByText("Mcode")).toBeInTheDocument();
  });

  it("renders the empty thread state", () => {
    render(<App />);
    expect(screen.getByText("Select a thread")).toBeInTheDocument();
  });
});
