import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThreadCompletionProjectTreePrototype } from "./ThreadCompletionProjectTreePrototype";

function renderPrototype(initialVariant: "A" | "B" | "C") {
  return render(
    <TooltipProvider>
      <ThreadCompletionProjectTreePrototype initialVariant={initialVariant} />
    </TooltipProvider>,
  );
}

describe("ThreadCompletionProjectTreePrototype", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?threadCompletionPrototype=A");
  });

  it("moves a reopened thread from the completed view to the active view", async () => {
    const user = userEvent.setup();
    renderPrototype("A");

    await user.click(screen.getByRole("button", { name: "View 3 completed" }));
    const completedThreads = screen.getByRole("region", {
      name: "Mcode, completed threads",
    });
    const completedThread = within(completedThreads).getByTestId(
      "prototype-thread-provider-adapter",
    );

    await user.click(
      within(completedThread).getByRole("button", { name: "Reopen thread" }),
    );

    expect(completedThread).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(
      within(
        screen.getByRole("region", { name: "Mcode, active threads" }),
      ).getByText("Provider adapter conformance"),
    ).toBeInTheDocument();
  });

  it("switches variants with the keyboard and updates the URL", async () => {
    const user = userEvent.setup();
    renderPrototype("A");

    await user.keyboard("{ArrowRight}");

    expect(screen.getByText("Prototype · B · Project switch")).toBeInTheDocument();
    expect(window.location.search).toBe("?threadCompletionPrototype=B");
  });

  it("does not let the user complete a running thread", () => {
    renderPrototype("A");

    expect(
      within(screen.getByTestId("prototype-thread-cleanup-safety")).getByRole(
        "button",
        { name: "Thread cannot be completed while running" },
      ),
    ).toBeDisabled();
  });
});
