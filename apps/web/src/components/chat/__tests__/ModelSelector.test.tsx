import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import React from "react";

// @base-ui/react (used by Button) does not work in jsdom; stub with a native button.
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ ...props }: React.ComponentProps<"input">) => <input {...props} />,
}));

/** Tooltip relies on Base UI and App-level TooltipProvider; unwrap triggers for jsdom. */
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactElement }) => <>{render}</>,
  TooltipContent: () => null,
}));

// Prevent real RPC calls triggered when a provider rail tab loads models.
vi.mock("@/transport", () => ({
  getTransport: () => ({
    listProviderModels: vi.fn().mockResolvedValue([]),
  }),
}));

import { ModelSelector } from "../ModelSelector";

beforeEach(() => {
  useProviderAvailabilityStore.setState({
    providers: [
      {
        id: "claude",
        enabled: true,
        hasAdapter: true,
        beta: false,
        comingSoon: false,
        cli: { status: "found", resolvedPath: "/a", configuredPath: "" },
      },
      {
        id: "codex",
        enabled: false,
        hasAdapter: true,
        beta: false,
        comingSoon: false,
        cli: { status: "found", resolvedPath: "/b", configuredPath: "" },
      },
    ] as never,
  });
});

describe("ModelSelector", () => {
  it("marks disabled providers with data-disabled='true' on their rail button", async () => {
    render(
      <ModelSelector
        selectedModelId="claude-sonnet-4-6"
        selectedProviderId="claude"
        onSelect={vi.fn()}
        locked={false}
      />,
    );

    const trigger = screen.getAllByRole("button")[0];
    await userEvent.click(trigger);

    const codexBtn = document.querySelector("[data-testid='model-group-codex']");
    expect(codexBtn).not.toBeNull();
    expect(codexBtn).toHaveAttribute("data-disabled", "true");
  });

  it("disables the rail button when the provider is disabled in settings", async () => {
    render(
      <ModelSelector
        selectedModelId="claude-sonnet-4-6"
        selectedProviderId="claude"
        onSelect={vi.fn()}
        locked={false}
      />,
    );

    const trigger = screen.getAllByRole("button")[0];
    await userEvent.click(trigger);

    const codexBtn = document.querySelector("[data-testid='model-group-codex']") as HTMLButtonElement | null;
    expect(codexBtn).not.toBeNull();
    expect(codexBtn?.disabled).toBe(true);
  });

  it("does not mark enabled providers as disabled", async () => {
    render(
      <ModelSelector
        selectedModelId="claude-sonnet-4-6"
        selectedProviderId="claude"
        onSelect={vi.fn()}
        locked={false}
      />,
    );

    const trigger = screen.getAllByRole("button")[0];
    await userEvent.click(trigger);

    const claudeBtn = document.querySelector("[data-testid='model-group-claude']");
    expect(claudeBtn).toHaveAttribute("data-disabled", "false");
  });

  it("returns the provider that owns a selected model", async () => {
    useProviderAvailabilityStore.setState({
      providers: [
        {
          id: "claude",
          enabled: true,
          hasAdapter: true,
          beta: false,
          comingSoon: false,
          cli: { status: "found", resolvedPath: "/a", configuredPath: "" },
        },
        {
          id: "codex",
          enabled: true,
          hasAdapter: true,
          beta: false,
          comingSoon: false,
          cli: { status: "found", resolvedPath: "/b", configuredPath: "" },
        },
      ] as never,
    });
    const onSelect = vi.fn();

    render(
      <ModelSelector
        selectedModelId="claude-sonnet-4-6"
        selectedProviderId="claude"
        onSelect={onSelect}
        locked={false}
      />,
    );

    await userEvent.click(screen.getAllByRole("button")[0]);
    await userEvent.click(screen.getByTestId("model-group-codex"));
    await userEvent.click(await screen.findByRole("button", { name: "Select GPT-5.6 Sol" }));

    expect(onSelect).toHaveBeenCalledWith("gpt-5.6-sol", "codex");
  });
});
