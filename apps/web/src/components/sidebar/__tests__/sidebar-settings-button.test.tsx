/**
 * Tests for the "Edit settings.json" button in the Sidebar footer.
 *
 * Verifies the button uses the Braces icon rather than a raw "{}" text span
 * with font-mono styling.
 *
 * IS_DESKTOP is a module-level const evaluated at import time. We work around
 * this by setting window.desktopBridge before the module load and using
 * vi.doMock (non-hoisted) + vi.resetModules() to reload the module fresh per
 * test group.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

describe('Sidebar "Edit settings.json" button', () => {
  let Sidebar: React.ComponentType<{
    settingsOpen?: boolean;
    settingsSection?: string;
    onSettingsSection?: (s: string) => void;
    onOpenSettings: () => void;
    onCloseSettings?: () => void;
  }>;

  beforeAll(async () => {
    // Set desktopBridge before module load so IS_DESKTOP evaluates to true.
    (window as unknown as Record<string, unknown>).desktopBridge = {
      openSettingsFile: vi.fn(),
    };

    // Register non-hoisted mocks for heavy transitive deps.
    vi.doMock("@/features/projects/ProjectTree", () => ({
      ProjectTree: () =>
        React.createElement("div", { "data-testid": "project-tree" }),
    }));
    vi.doMock("@/components/settings/SettingsNav", () => ({
      SettingsNav: () =>
        React.createElement("div", { "data-testid": "settings-nav" }),
    }));

    // Reset module registry so the fresh import picks up desktopBridge.
    vi.resetModules();

    const mod = await import("../Sidebar");
    Sidebar = mod.Sidebar as typeof Sidebar;
  }, 30_000);

  afterAll(() => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    vi.resetModules();
    vi.clearAllMocks();
  });

  /** Render Sidebar in settings-open mode with a desktop bridge present. */
  function renderSettingsSidebar() {
    return render(
      React.createElement(Sidebar, {
        settingsOpen: true,
        settingsSection: "general",
        onSettingsSection: vi.fn(),
        onOpenSettings: vi.fn(),
        onCloseSettings: vi.fn(),
      }),
    );
  }

  /** Render the main project sidebar navigation. */
  function renderProjectSidebar() {
    return render(
      React.createElement(Sidebar, {
        onOpenSettings: vi.fn(),
      }),
    );
  }

  it("does not render a span with font-mono text-xs class containing {}", () => {
    const { container } = renderSettingsSidebar();

    const monoSpans = container.querySelectorAll("span.font-mono.text-xs");
    const hasRawBraces = Array.from(monoSpans).some(
      (el) => el.textContent === "{}",
    );
    expect(hasRawBraces).toBe(false);
  });

  it("does not contain the literal text {} in the rendered output", () => {
    const { container } = renderSettingsSidebar();
    expect(container.innerHTML).not.toContain("{}");
  });

  it('renders an SVG icon inside the "Edit settings.json" button', () => {
    renderSettingsSidebar();

    const editButton = screen.getByRole("button", {
      name: /Edit settings\.json/i,
    });
    const svgInButton = editButton.querySelector("svg");
    expect(svgInButton).not.toBeNull();
  });

  it('the icon inside "Edit settings.json" has the lucide-braces class', () => {
    renderSettingsSidebar();

    const editButton = screen.getByRole("button", {
      name: /Edit settings\.json/i,
    });
    const svg = editButton.querySelector("svg");
    expect(svg?.classList.contains("lucide-braces")).toBe(true);
  });

  it("keeps the primary sidebar actions on the same neutral treatment", () => {
    renderProjectSidebar();

    const newThread = screen.getByRole("button", { name: "New thread" });
    const searchThreads = screen.getByRole("button", {
      name: "Search threads",
    });
    expect(newThread).not.toHaveClass("bg-secondary");
    expect(searchThreads).not.toHaveClass("bg-secondary");
  });

  it("keeps New thread and Search threads ahead of Pull requests without a duplicate Chat action", () => {
    renderProjectSidebar();

    expect(
      screen.queryByRole("button", { name: "Chat" }),
    ).not.toBeInTheDocument();
    const newThread = screen.getByRole("button", { name: "New thread" });
    const searchThreads = screen.getByRole("button", {
      name: "Search threads",
    });
    const pullRequests = screen.getByRole("button", { name: "Pull requests" });
    expect(newThread.compareDocumentPosition(searchThreads)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(searchThreads.compareDocumentPosition(pullRequests)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("omits desktop branding and collapse controls from the project sidebar", () => {
    renderProjectSidebar();

    expect(
      screen.queryByRole("img", { name: "Mcode" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse sidebar" }),
    ).not.toBeInTheDocument();
  });

  it("does not display a keyboard shortcut beside thread search", () => {
    renderProjectSidebar();

    expect(screen.queryByText("Ctrl Shift F")).not.toBeInTheDocument();
    expect(screen.queryByText("⌘⇧F")).not.toBeInTheDocument();
  });
});
