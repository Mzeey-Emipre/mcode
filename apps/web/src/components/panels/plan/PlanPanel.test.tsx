import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { PlanPanel } from "./PlanPanel";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const makePlan = (version: number, contentMd: string): PlanRecord => ({
  id: `plan-${version}`,
  threadId: "thread-plan",
  messageId: `00000000-0000-4000-8000-00000000000${version}`,
  version,
  title: `Version ${version} Plan`,
  contentMd,
  sectionsJson: [
    {
      id: `section-${version}`,
      title: `Version ${version} Step`,
      level: 2,
    },
  ],
  changeSummary: version === 1 ? null : `Updated to version ${version}`,
  status: version === 1 ? "superseded" : "draft",
  createdAt: `2026-05-23T00:00:0${version}.000Z`,
});

describe("PlanPanel", () => {
  beforeAll(async () => {
    await import("@/components/chat/MarkdownContent");
  }, 30_000);

  beforeEach(() => {
    resetThreadStoreForTests({
      currentThreadId: null,
      runningThreadIds: new Set(),
    });
    useWorkspaceStore.setState({
      threads: [
        createMockThread({
          id: "thread-plan",
          interaction_mode: "plan",
        }),
      ],
    });
    usePlanStore.setState({
      plansByThread: {},
      activeVersionByThread: {},
      generatingThreads: new Set(),
    });
    vi.clearAllMocks();
  });

  it("sends the selected plan version content when implementing", async () => {
    const versionOne = makePlan(1, "## Old path\n\nDo the old implementation.");
    const versionTwo = makePlan(2, "## New path\n\nDo the new implementation.");
    usePlanStore.setState({
      plansByThread: { "thread-plan": [versionOne, versionTwo] },
      activeVersionByThread: { "thread-plan": 2 },
    });

    render(<PlanPanel threadId="thread-plan" />);

    fireEvent.click(screen.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(mockTransport.sendMessage).toHaveBeenCalled());
    const sendCall = vi.mocked(mockTransport.sendMessage).mock.calls.at(-1)?.[0];
    const content = sendCall?.content;

    expect(content).toContain('Implement plan v2: "Version 2 Plan".');
    expect(content).toContain(versionTwo.contentMd);
    expect(content).not.toContain(versionOne.contentMd);
    expect(sendCall?.planAction).toBe("implement");
  }, 15_000);

  it("moves from an old active version to the latest generated plan when there are no annotations", async () => {
    const versionOne = makePlan(1, "## Old path\n\nDo the old implementation.");
    const versionTwo = makePlan(2, "## New path\n\nDo the new implementation.");
    usePlanStore.setState({
      plansByThread: { "thread-plan": [versionOne, versionTwo] },
      activeVersionByThread: { "thread-plan": 1 },
    });

    render(<PlanPanel threadId="thread-plan" />);

    await waitFor(() => {
      expect(usePlanStore.getState().activeVersionByThread["thread-plan"]).toBeNull();
    });
    expect(await screen.findByText("Version 2 Plan")).toBeInTheDocument();
    expect(screen.queryByText(/Viewing v1 of 2/)).not.toBeInTheDocument();
  }, 15_000);

  it("keeps the old active version when the user has annotation feedback drafted", async () => {
    const versionOne = makePlan(1, "## Old path\n\nDo the old implementation.");
    const versionTwo = makePlan(2, "## New path\n\nDo the new implementation.");
    usePlanStore.setState({
      plansByThread: { "thread-plan": [versionOne] },
      activeVersionByThread: { "thread-plan": 1 },
    });

    render(<PlanPanel threadId="thread-plan" />);

    const heading = await screen.findByText("Old path", {}, { timeout: 5000 });
    fireEvent.click(heading);
    const textarea = await screen.findByPlaceholderText("What should change in this section?", {}, { timeout: 5000 });
    fireEvent.change(textarea, { target: { value: "keep reviewing this draft" } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Feedback (1)" })).toBeInTheDocument();
    });

    act(() => {
      usePlanStore.setState({
        plansByThread: { "thread-plan": [versionOne, versionTwo] },
        activeVersionByThread: { "thread-plan": 1 },
      });
    });

    await expect(screen.findByText(/Viewing v1 of 2/)).resolves.toBeInTheDocument();
    expect(usePlanStore.getState().activeVersionByThread["thread-plan"]).toBe(1);
    expect(screen.getByText("Version 1 Plan")).toBeInTheDocument();
  }, 15_000);
});
