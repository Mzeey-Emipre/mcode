import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HookRow } from "../HookRow";
import type { HookExecution } from "@/transport/types";

function makeHook(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    hookName: "SessionStart:startup",
    hookType: "stop",
    status: "completed",
    outputLines: [],
    fullOutput: [],
    startedAt: 1_700_000_000_000,
    durationMs: 32,
    exitCode: 0,
    didBlock: false,
    ...overrides,
  };
}

describe("HookRow", () => {
  function closestCollapsible(element: HTMLElement): HTMLElement {
    const collapsible = element.closest(".grid");
    if (!(collapsible instanceof HTMLElement)) {
      throw new Error("Expected hook detail to be inside AnimatedCollapsible");
    }
    return collapsible;
  }

  it("renders the hook row with the shared tool summary row scale", () => {
    render(<HookRow hook={makeHook()} />);

    const row = screen.getByRole("button", { name: /SessionStart:startup/ });

    expect(row).toHaveClass("text-sm");
    expect(row).toHaveClass("px-2", "py-1", "rounded-md");
    expect(screen.getByText("SessionStart:startup")).toHaveClass("text-muted-foreground/60");
  });

  it("renders expanded output at narrative text size", async () => {
    const user = userEvent.setup();
    render(<HookRow hook={makeHook({ outputLines: ["startup ok"], fullOutput: ["startup ok"] })} />);

    const detail = screen.getByText("startup ok");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[0fr]");

    await user.click(screen.getByRole("button", { name: /SessionStart:startup/ }));

    expect(detail).toHaveClass("text-sm");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[1fr]");
  });

  it("previews live output lines and expands to full output", async () => {
    const user = userEvent.setup();
    render(
      <HookRow
        hook={makeHook({
          outputLines: ["preview line"],
          fullOutput: ["preview line", "full line"],
        })}
      />,
    );

    const detail = screen.getByText("preview line");
    expect(screen.getByText("full line")).toHaveClass("text-sm");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[0fr]");

    await user.click(screen.getByRole("button", { name: /SessionStart:startup/ }));

    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[1fr]");
  });

  it("renders persisted hook detail after expansion when stdout is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <HookRow
        hook={makeHook({
          outputLines: ["phase: stop", "tool: Bash", "blocked: yes"],
          fullOutput: ["phase: stop", "tool: Bash", "blocked: yes"],
          detailLines: ["phase: stop", "tool: Bash", "blocked: yes"],
          didBlock: true,
        })}
      />,
    );

    const detail = screen.getByText(/phase: stop/);
    expect(screen.getByText(/tool: Bash/)).toHaveClass("text-sm");
    expect(screen.getByText(/blocked: yes/)).toHaveClass("text-sm");
    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[0fr]");

    await user.click(screen.getByRole("button", { name: /SessionStart:startup/ }));

    expect(closestCollapsible(detail)).toHaveClass("grid-rows-[1fr]");
  });

  it("does not overflow narrow containers with long hook names", () => {
    const { container } = render(
      <div style={{ width: 360 }}>
        <HookRow
          hook={makeHook({
            hookName: "SessionStart:startup:with-a-long-single-token-hook-name",
            toolName: "VeryLongToolNameWithoutNaturalBreaks",
          })}
        />
      </div>,
    );

    const wrapper = container.firstElementChild as HTMLElement;
    const row = screen.getByRole("button", { name: /SessionStart:startup/ });

    expect(row).toHaveClass("min-w-0", "overflow-hidden");
    expect(screen.getByText(/SessionStart:startup/)).toHaveClass("min-w-0", "truncate");
    expect(wrapper.scrollWidth).toBeLessThanOrEqual(wrapper.clientWidth);
  });
});
