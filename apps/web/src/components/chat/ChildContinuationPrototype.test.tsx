import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChildContinuationPrototypeStore } from "@/stores/childContinuationPrototypeStore";

const { mockOpenSubagentsPanel } = vi.hoisted(() => ({
  mockOpenSubagentsPanel: vi.fn(),
}));

vi.mock("@/lib/open-subagent-detail", () => ({
  openSubagentsPanel: mockOpenSubagentsPanel,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ChildContinuationPrototype } from "./ChildContinuationPrototype";

describe("ChildContinuationPrototype", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?prototype=child-continuation");
    useChildContinuationPrototypeStore.getState().reset();
    mockOpenSubagentsPanel.mockReset();
  });

  it("keeps grouped child lifecycle text outside each named agent button", () => {
    window.history.replaceState(null, "", "/?prototype=child-continuation&variant=C");
    render(<ChildContinuationPrototype />);

    expect(screen.queryByRole("button", { name: "Previous prototype variant" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next prototype variant" })).not.toBeInTheDocument();
    for (const label of ["Advance Schema scan", "Later parent turn", "At tail", "Reading above", "Reset"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    const rollbackButton = screen.getByRole("button", {
      name: "Open Rollback check subagent details, working",
    });
    expect(rollbackButton).toHaveTextContent("Rollback check");
    expect(rollbackButton).not.toHaveTextContent("working");
    expect(rollbackButton.parentElement).toHaveTextContent("working");

    const schemaButton = screen.getByRole("button", {
      name: "Open Schema scan subagent details, started working",
    });
    expect(schemaButton).not.toHaveTextContent("started working");
    expect(schemaButton.parentElement).toHaveTextContent("started working");

    expect(screen.getByRole("button", {
      name: "Open full Subagents roster, +2 working, 1 finished",
    })).toBeInTheDocument();

    fireEvent.click(rollbackButton);
    expect(mockOpenSubagentsPanel).toHaveBeenCalledOnce();
  });
});
