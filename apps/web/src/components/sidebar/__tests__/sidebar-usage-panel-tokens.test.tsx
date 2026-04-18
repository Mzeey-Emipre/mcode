/**
 * Verifies that SidebarUsagePanel uses only design tokens and no hardcoded
 * gray-* Tailwind classes in the rendered DOM.
 *
 * The gray classes live inside PopoverContent, which Base UI renders into a
 * portal at document.body. We trigger mouseenter on the popover trigger so
 * the content is mounted, then check the full body for gray-* class names.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import React from "react";

describe("SidebarUsagePanel design tokens", () => {
  let SidebarUsagePanel: React.ComponentType;

  beforeAll(async () => {
    // Mock stores so the component renders without a real transport layer.
    vi.doMock("@/stores/workspaceStore", () => ({
      useWorkspaceStore: (selector: (s: unknown) => unknown) =>
        selector({
          activeThreadId: "thread-1",
          threads: [{ id: "thread-1", model: "claude-3-5-sonnet", provider: "claude" }],
        }),
    }));

    vi.doMock("@/stores/threadStore", () => ({
      useThreadStore: (selector: (s: unknown) => unknown) =>
        selector({
          usageByProvider: {
            "thread-1:claude": {
              quotaCategories: [
                { label: "Tokens", used: 5000, total: 10000, remainingPercent: 0.5, isUnlimited: false },
              ],
              sessionCostUsd: 0.0042,
              serviceTier: "standard",
              numTurns: 3,
              durationMs: 12500,
            },
          },
          contextByThread: {
            "thread-1": {
              lastTokensIn: 4000,
              contextWindow: 100000,
              tokensOut: 500,
              cacheReadTokens: 200,
              cacheWriteTokens: 100,
            },
          },
          fetchProviderUsage: vi.fn(),
        }),
    }));

    vi.doMock("@/stores/composerDraftStore", () => ({
      useComposerDraftStore: (selector: (s: unknown) => unknown) =>
        selector({ drafts: {} }),
    }));

    vi.resetModules();

    const mod = await import("../SidebarUsagePanel");
    SidebarUsagePanel = mod.SidebarUsagePanel as React.ComponentType;
  });

  afterAll(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("renders without any gray-* Tailwind classes in the DOM", () => {
    const { container } = render(React.createElement(SidebarUsagePanel));

    // Trigger mouseenter on the PopoverTrigger to open the popover,
    // which causes Base UI to portal-render PopoverContent into document.body.
    const trigger = container.querySelector('[data-slot="popover-trigger"]');
    act(() => {
      fireEvent.mouseEnter(trigger!);
    });

    // Check the entire body since PopoverContent renders into a portal.
    const allClasses = Array.from(document.body.querySelectorAll("*"))
      .map((el) => el.getAttribute("class") ?? "")
      .join(" ");
    expect(allClasses).not.toMatch(/\bgray-\d+\b/);
  });
});
