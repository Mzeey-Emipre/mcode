import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
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
    const sendCall = vi.mocked(mockTransport.sendMessage).mock.calls.at(-1);
    const content = sendCall?.[1];

    expect(content).toContain('Implement plan v2: "Version 2 Plan".');
    expect(content).toContain(versionTwo.contentMd);
    expect(content).not.toContain(versionOne.contentMd);
    expect(sendCall?.[15]).toBe("implement");
  }, 15_000);
});
