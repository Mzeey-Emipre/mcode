import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { PlanChrome } from "./PlanChrome";

const plan: PlanRecord = {
  id: "plan-1",
  threadId: "t1",
  messageId: "00000000-0000-4000-8000-000000000001",
  version: 1,
  title: "A Plan",
  contentMd: "## Step\n\nDo it.",
  sectionsJson: [{ id: "s1", title: "Step", level: 2 }],
  changeSummary: null,
  status: "draft",
  createdAt: "2026-06-03T00:00:01.000Z",
};

beforeEach(() => {
  usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {}, generatingThreads: new Set() });
  vi.clearAllMocks();
});

describe("PlanChrome Implement button", () => {
  it("always renders Implement as a glowing primary action", () => {
    render(
      <PlanChrome
        plan={plan}
        allVersions={[plan]}
        threadId="t1"
        onRevise={() => {}}
        onImplement={() => {}}
        commentCount={0}
      />,
    );
    const implement = screen.getByRole("button", { name: /implement/i });
    expect(implement).toBeInTheDocument();
    expect(implement.className).toContain("animate-plan-implement-glow");
  });
});
