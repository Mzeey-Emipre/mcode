import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { App } from "../app/App";

// Mock the transport module to prevent WebSocket initialization during tests
vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  initTransport: vi.fn().mockResolvedValue({}),
  getTransport: () => ({
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    createAndSendMessage: vi.fn().mockResolvedValue({ id: "t1", title: "test", model: null }),
    updateThreadTitle: vi.fn().mockResolvedValue(true),
    createWorkspace: vi.fn().mockResolvedValue({}),
    deleteWorkspace: vi.fn().mockResolvedValue(true),
    createThread: vi.fn().mockResolvedValue({}),
    deleteThread: vi.fn().mockResolvedValue(true),
    stopAgent: vi.fn().mockResolvedValue(undefined),
    getActiveAgentCount: vi.fn().mockResolvedValue(0),
    discoverConfig: vi.fn().mockResolvedValue({}),
    getVersion: vi.fn().mockResolvedValue("0.2.0"),
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
  it("renders the sidebar with app title", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Mcode")).toBeInTheDocument());
  });

  it("renders the empty thread state", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Select a thread")).toBeInTheDocument());
  });
});
