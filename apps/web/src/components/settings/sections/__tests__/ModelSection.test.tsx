import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted ensures these refs are available inside the vi.mock factory below.
const { mockSettingsSelector } = vi.hoisted(() => ({
  mockSettingsSelector: vi.fn(),
}));

vi.mock("@/stores/settingsStore", () => {
  const store = Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => mockSettingsSelector(selector)),
    {
      getState: vi.fn().mockReturnValue({
        settings: {
          model: { defaults: { provider: "claude", id: "claude-opus-4-7", reasoning: "high", fallbackId: "" } },
          provider: { cli: { codex: "", claude: "", copilot: "" } },
          prDraft: { provider: "", model: "" },
        },
      }),
      setState: vi.fn(),
    },
  );
  return { useSettingsStore: store };
});

// @base-ui/react (used by Tooltip) does not work in jsdom; stub it out.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Select primitives from Radix can be tricky in jsdom; stub them since the
// reasoning row always uses SegControl (not Select) in the tested scenarios.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}));

import { ModelSection } from "../ModelSection";

/** Builds the full settings state shape required by ModelSection. */
function makeState(provider: string, modelId: string, reasoning = "high") {
  return {
    settings: {
      model: {
        defaults: { provider, id: modelId, reasoning, fallbackId: "" },
      },
      provider: { cli: { codex: "", claude: "", copilot: "" } },
      prDraft: { provider: "", model: "" },
    },
    update: vi.fn(),
  };
}

/**
 * Renders ModelSection after configuring the store mock to return the given
 * provider and model. Returns the rendered component for optional further querying.
 */
function renderWithModel(provider: string, modelId: string, reasoning = "high") {
  const state = makeState(provider, modelId, reasoning);
  mockSettingsSelector.mockImplementation((selector: (s: unknown) => unknown) =>
    selector(state),
  );
  return render(<ModelSection />);
}

/**
 * Finds the reasoning effort SegControl radiogroup.
 * The component renders multiple radiogroups (provider, model, fallback, reasoning);
 * we locate ours by finding the "Reasoning effort" label and querying within its row.
 */
function getReasoningRow(): HTMLElement {
  const label = screen.getByText("Reasoning effort");
  // Walk up to the SettingRow container div (two levels up from the <span>)
  const row = label.closest("div[class]")?.parentElement as HTMLElement;
  return row;
}

describe("ModelSection reasoning options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders reasoning options in order: Low, Medium, High, X-High, Max for Claude Opus 4.7", () => {
    renderWithModel("claude", "claude-opus-4-7");

    const row = getReasoningRow();
    const radios = within(row).getAllByRole("radio");
    const labels = radios.map((r) => r.textContent?.trim());

    expect(labels).toEqual(["Low", "Medium", "High", "X-High", "Max"]);
  });

  it("X-High is enabled for Claude Opus 4.7", () => {
    renderWithModel("claude", "claude-opus-4-7");

    const row = getReasoningRow();
    const xhigh = within(row).getByRole("radio", { name: "X-High" });

    expect(xhigh).not.toBeDisabled();
  });

  it("X-High is disabled for Claude Sonnet 4.6", () => {
    renderWithModel("claude", "claude-sonnet-4-6");

    const row = getReasoningRow();
    const xhigh = within(row).getByRole("radio", { name: "X-High" });

    expect(xhigh).toBeDisabled();
  });

  it("Max is enabled for Claude Sonnet 4.6", () => {
    renderWithModel("claude", "claude-sonnet-4-6");

    const row = getReasoningRow();
    const max = within(row).getByRole("radio", { name: "Max" });

    expect(max).not.toBeDisabled();
  });

  it("Max is enabled for Claude Opus 4.6", () => {
    renderWithModel("claude", "claude-opus-4-6");

    const row = getReasoningRow();
    const max = within(row).getByRole("radio", { name: "Max" });

    expect(max).not.toBeDisabled();
  });

  it("Reasoning Effort row is hidden for Claude Haiku 4.5", () => {
    renderWithModel("claude", "claude-haiku-4-5");

    expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
  });

  it("Reasoning Effort row is visible for Claude Opus 4.7", () => {
    renderWithModel("claude", "claude-opus-4-7");

    expect(screen.getByText("Reasoning effort")).toBeInTheDocument();
  });

  it("Reasoning Effort row is visible for Claude Sonnet 4.6", () => {
    renderWithModel("claude", "claude-sonnet-4-6");

    expect(screen.getByText("Reasoning effort")).toBeInTheDocument();
  });
});
