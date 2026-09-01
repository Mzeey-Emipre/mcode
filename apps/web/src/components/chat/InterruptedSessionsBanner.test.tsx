import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { InterruptedSessionsBanner } from "./InterruptedSessionsBanner";

describe("InterruptedSessionsBanner", () => {
  const incident = {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-09-01T12:00:00.000Z",
    entries: [
      {
        workspaceId: "workspace-a",
        workspaceName: "Project A",
        threadId: "thread-a",
        threadTitle: "Thread A",
        executionId: "00000000-0000-4000-8000-000000000002",
        startedAt: "2026-09-01T11:59:55.800Z",
        interruptedAt: "2026-09-01T12:00:00.000Z",
        durationMs: 4_200,
      },
      {
        workspaceId: "workspace-b",
        workspaceName: "Project B",
        threadId: "thread-b",
        threadTitle: "Thread B",
        executionId: "00000000-0000-4000-8000-000000000003",
        startedAt: "2026-09-01T11:58:55.000Z",
        interruptedAt: "2026-09-01T12:00:00.000Z",
        durationMs: 65_000,
      },
    ],
  };

  it("lists every interrupted turn without recovery controls", () => {
    render(<InterruptedSessionsBanner incident={incident} onDismiss={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Turns were interrupted during a server restart.");
    expect(screen.getByTestId("recovery-incident-entry-00000000-0000-4000-8000-000000000002")).toHaveTextContent("Project A · Thread A · 4.2s");
    expect(screen.getByTestId("recovery-incident-entry-00000000-0000-4000-8000-000000000003")).toHaveTextContent("Project B · Thread B · 1m 5s");
    expect(screen.queryByRole("button", { name: /continue|retry|resume/i })).toBeNull();
  });

  it("calls onDismiss when X button is clicked", async () => {
    const user = userEvent.setup();
    const mockDismiss = vi.fn();
    render(
      <InterruptedSessionsBanner
        incident={incident}
        onDismiss={mockDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(mockDismiss).toHaveBeenCalledOnce();
  });
});
