import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserHeader, type BrowserHeaderProps } from "../BrowserHeader";

function renderHeader(overrides: Partial<BrowserHeaderProps> = {}) {
  const props: BrowserHeaderProps = {
    url: "https://example.com/",
    pageTitle: "Example",
    faviconUrl: null,
    hasLoadedPage: true,
    canBack: false,
    canFwd: false,
    threadId: "thread-1",
    designModeActive: false,
    elementPickBusy: false,
    captureBusy: false,
    regionBusy: false,
    onNavigate: vi.fn(),
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onReload: vi.fn(),
    onOpenExternal: vi.fn(),
    onToggleDesign: vi.fn(),
    onScreenshot: vi.fn(),
    onNewPage: vi.fn(),
    onForceReload: vi.fn(),
    onRegionCapture: vi.fn(),
    onDumpContent: vi.fn(),
    onClearCookies: vi.fn(),
    onClearCache: vi.fn(),
    onGetZoom: vi.fn().mockResolvedValue(1),
    onSetZoom: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
  render(<TooltipProvider><BrowserHeader {...props} /></TooltipProvider>);
  return props;
}

describe("BrowserHeader", () => {
  it("does not render a browser-local automation controller capsule", () => {
    renderHeader();
    expect(screen.queryByTestId("browser-controller-badge")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop browser automation" })).not.toBeInTheDocument();
  });

  it("keeps takeover in overflow instead of the header badge", async () => {
    const user = userEvent.setup();
    const onStopAutomation = vi.fn();
    renderHeader({
      automationController: {
        tabId: "tab-1",
        controller: "agent",
        controlEpoch: 1,
        providerSessionId: "provider-session",
        operation: "click",
      },
      automationBusy: true,
      onStopAutomation,
    });
    expect(screen.queryByTestId("browser-controller-badge")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    await user.click(await screen.findByText("Take control"));
    expect(onStopAutomation).toHaveBeenCalledOnce();
  });

  it("keeps takeover available while an agent-owned tab is idle", async () => {
    const user = userEvent.setup();
    const onStopAutomation = vi.fn();
    renderHeader({
      automationController: {
        tabId: "tab-1",
        controller: "agent",
        controlEpoch: 1,
      },
      automationBusy: false,
      onStopAutomation,
    });

    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    await user.click(await screen.findByText("Take control"));
    expect(onStopAutomation).toHaveBeenCalledOnce();
  });

  it("opens adopted guest DevTools from the enabled menu item", async () => {
    const user = userEvent.setup();
    const onOpenDevTools = vi.fn();
    renderHeader({ onOpenDevTools });
    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    await user.click(await screen.findByText("Developer tools"));
    expect(onOpenDevTools).toHaveBeenCalledOnce();
  });
});
