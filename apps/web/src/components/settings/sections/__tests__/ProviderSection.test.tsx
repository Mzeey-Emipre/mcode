import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getDefaultSettings } from "@mcode/contracts";

// @base-ui/react (used by Switch) does not work in jsdom; stub it with a native button.
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    "data-testid": testId,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    "data-testid"?: string;
    [key: string]: unknown;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
}));

// @base-ui/react (used by Badge) does not work in jsdom; stub as a plain span.
vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    "data-testid": testId,
    ...rest
  }: {
    children?: React.ReactNode;
    "data-testid"?: string;
    [key: string]: unknown;
  }) => (
    <span data-testid={testId} {...rest}>
      {children}
    </span>
  ),
}));

// @base-ui/react (used by Tooltip) does not work in jsdom; stub it out.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ProviderSection } from "../ProviderSection";

beforeEach(() => {
  useSettingsStore.setState({ settings: getDefaultSettings(), update: async () => {} });
  useProviderAvailabilityStore.setState({
    providers: [
      { id: "claude",   enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, capabilities: [], cli: { status: "found",     resolvedPath: "/a", configuredPath: "" } },
      { id: "codex",    enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, capabilities: [], cli: { status: "not_found", resolvedPath: null, configuredPath: "" } },
      { id: "copilot",  enabled: false, hasAdapter: true,  beta: true,  comingSoon: false, capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "gemini",   enabled: false, hasAdapter: false, beta: false, comingSoon: true,  capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "cursor",   enabled: false, hasAdapter: false, beta: false, comingSoon: true,  capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "opencode", enabled: false, hasAdapter: false, beta: false, comingSoon: true,  capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
    ],
  });
});

describe("ProviderSection", () => {
  it("renders switches only for available providers", () => {
    render(<ProviderSection />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    expect(screen.queryByTestId("provider-switch-gemini")).not.toBeInTheDocument();
  });

  it("renders the Beta badge for copilot and Coming soon badges for planned providers", () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-badge-copilot-beta")).toBeInTheDocument();
    expect(screen.getByTestId("provider-badge-gemini-comingsoon")).toHaveAttribute(
      "variant",
      "secondary",
    );
    expect(screen.getByTestId("provider-badge-cursor-comingsoon")).toHaveAttribute(
      "variant",
      "secondary",
    );
    expect(screen.getByTestId("provider-badge-opencode-comingsoon")).toHaveAttribute(
      "variant",
      "secondary",
    );
  });

  it("groups planned providers after available providers without adapter copy", () => {
    render(<ProviderSection />);

    const comingSoon = screen.getByTestId("coming-soon-providers");
    expect(within(comingSoon).getByText("Gemini")).toBeInTheDocument();
    expect(within(comingSoon).getByText("Cursor")).toBeInTheDocument();
    expect(within(comingSoon).getByText("Opencode")).toBeInTheDocument();
    expect(screen.queryByText("Adapter not available yet.")).not.toBeInTheDocument();
    expect(
      screen
        .getByTestId("provider-config-trigger-copilot")
        .compareDocumentPosition(comingSoon) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a CLI-not-found badge when enabled and status='not_found'", () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-badge-codex-cli-missing")).toBeInTheDocument();
  });

  it("does not render controls for coming-soon providers", () => {
    render(<ProviderSection />);
    expect(screen.queryByTestId("provider-switch-gemini")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-config-trigger-gemini")).not.toBeInTheDocument();
  });

  it("keeps stable provider configuration collapsed and opens Beta configuration by default", () => {
    render(<ProviderSection />);
    expect(screen.queryByTestId("provider-cli-path-claude")).not.toBeInTheDocument();
    expect(screen.getByTestId("provider-cli-path-copilot")).toBeEnabled();
    expect(screen.queryByTestId("provider-cli-path-gemini")).not.toBeInTheDocument();
  });

  it("updates a disabled Beta provider's CLI path", () => {
    const update = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: getDefaultSettings(), update });
    render(<ProviderSection />);

    fireEvent.change(screen.getByTestId("provider-cli-path-copilot"), {
      target: { value: "/custom/copilot" },
    });

    expect(update).toHaveBeenCalledWith({
      provider: { cli: { copilot: "/custom/copilot" } },
    });
  });

  it("expands a stable provider's CLI path on request", async () => {
    const user = userEvent.setup();
    render(<ProviderSection />);

    await user.click(screen.getByTestId("provider-config-trigger-claude"));

    expect(screen.getByTestId("provider-cli-path-claude")).toBeVisible();
  });

  it("keeps expanded provider triggers visually neutral", () => {
    render(<ProviderSection />);

    expect(screen.getByTestId("provider-config-trigger-copilot")).toHaveClass(
      "aria-expanded:bg-transparent",
      "dark:aria-expanded:bg-transparent",
    );
  });

  it("does not expose a disclosure trigger for coming-soon providers", () => {
    render(<ProviderSection />);

    expect(screen.queryByTestId("provider-config-trigger-gemini")).not.toBeInTheDocument();
  });
});
