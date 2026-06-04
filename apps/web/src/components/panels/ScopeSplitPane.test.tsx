import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import type { TaskItem } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import { useTaskStore } from "@/stores/taskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { ScopeSplitPane } from "./ScopeSplitPane";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD = "thread-scope";

const makePlan = (version: number): PlanRecord => ({
  id: `plan-${version}`,
  threadId: THREAD,
  messageId: `00000000-0000-4000-8000-00000000000${version}`,
  version,
  title: `Version ${version} Plan`,
  contentMd: "## Step\n\nDo the thing.",
  sectionsJson: [{ id: `s${version}`, title: "Step", level: 2 }],
  changeSummary: null,
  status: "draft",
  createdAt: `2026-06-03T00:00:0${version}.000Z`,
});

const makeTask = (id: string): TaskItem => ({
  id,
  content: `Task ${id}`,
  status: "pending",
  group: "Tasks",
});

beforeEach(() => {
  usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {}, generatingThreads: new Set() });
  useTaskStore.setState({ tasksByThread: {} });
  useWorkspaceStore.setState({
    activeThreadId: THREAD,
    threads: [createMockThread({ id: THREAD, interaction_mode: "plan" })],
  });
  vi.clearAllMocks();
});

describe("ScopeSplitPane adaptive dock", () => {
  it("shows the resizable split when a plan and tasks both exist", () => {
    usePlanStore.setState({ plansByThread: { [THREAD]: [makePlan(1)] } });
    useTaskStore.setState({ tasksByThread: { [THREAD]: [makeTask("a")] } });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[makeTask("a")]} />);
    expect(screen.getByTestId("plan-panel-viewport")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: /resize plan and tasks/i }),
    ).toBeInTheDocument();
  });

  it("fills the pane with tasks (no plan region, no divider) when there is no plan", () => {
    useTaskStore.setState({ tasksByThread: { [THREAD]: [makeTask("a")] } });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[makeTask("a")]} />);
    expect(screen.queryByTestId("plan-panel-viewport")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("shows only the empty docket (no plan region, no divider) when no plan and no tasks", () => {
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[]} />);
    expect(screen.getByText(/nothing on the docket/i)).toBeInTheDocument();
    expect(screen.queryByTestId("plan-panel-viewport")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("fills the pane with the plan (no divider) when a plan exists but there are no tasks", () => {
    usePlanStore.setState({ plansByThread: { [THREAD]: [makePlan(1)] } });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[]} />);
    expect(screen.getByTestId("plan-panel-viewport")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("shows the skeleton while generating with no tasks, and no divider", () => {
    usePlanStore.setState({ generatingThreads: new Set([THREAD]) });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[]} />);
    expect(screen.getByTestId("plan-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
