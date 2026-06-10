/**
 * Behaviour tests for the right-panel empty-state tool list (issue #610):
 * scope-filtered rows, the Files coming-soon teaser, the absence of an add
 * control, and opening a tab by clicking its row.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PanelEmptyState } from "../PanelEmptyState";
import { loadKeybindings, clearKeybindings } from "@/lib/keybinding-manager";
import defaultKeybindings from "@/config/default-keybindings.json";

beforeEach(() => {
  clearKeybindings();
  loadKeybindings(defaultKeybindings);
});

describe("PanelEmptyState — scope filter", () => {
  it("threadless: shows Browser, Terminal, Files, and Review (dual-scope) but not Scope", () => {
    render(<PanelEmptyState scope="threadless" openTabs={[]} onOpen={vi.fn()} />);
    expect(screen.getByTestId("panel-card-preview")).toBeInTheDocument();
    expect(screen.getByTestId("panel-card-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("panel-card-files")).toBeInTheDocument();
    // Review is dual-scope: its git working-tree views need no thread.
    expect(screen.getByTestId("panel-card-changes")).toBeInTheDocument();
    expect(screen.queryByTestId("panel-card-tasks")).not.toBeInTheDocument();
  });

  it("thread: also shows Scope", () => {
    render(<PanelEmptyState scope="thread" openTabs={[]} onOpen={vi.fn()} />);
    expect(screen.getByTestId("panel-card-changes")).toBeInTheDocument();
    expect(screen.getByTestId("panel-card-tasks")).toBeInTheDocument();
  });
});

describe("PanelEmptyState — cardinality filter", () => {
  it("drops a type once it is open", () => {
    render(
      <PanelEmptyState scope="threadless" openTabs={["preview"]} onOpen={vi.fn()} />,
    );
    expect(screen.queryByTestId("panel-card-preview")).not.toBeInTheDocument();
    expect(screen.getByTestId("panel-card-terminal")).toBeInTheDocument();
  });
});

describe("PanelEmptyState — Files coming-soon teaser", () => {
  it("renders Files disabled with a Soon badge", () => {
    render(<PanelEmptyState scope="threadless" openTabs={[]} onOpen={vi.fn()} />);
    const files = screen.getByTestId("panel-card-files");
    expect(files).toBeDisabled();
    expect(screen.getByText(/soon/i)).toBeInTheDocument();
  });

  it("does not open Files when its card is clicked", () => {
    const onOpen = vi.fn();
    render(<PanelEmptyState scope="threadless" openTabs={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("panel-card-files"));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("PanelEmptyState — create surface", () => {
  it("opens a tab when its card is clicked", () => {
    const onOpen = vi.fn();
    render(<PanelEmptyState scope="threadless" openTabs={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("panel-card-preview"));
    expect(onOpen).toHaveBeenCalledWith("preview");
  });

  it("renders no add control (the grid is the create surface)", () => {
    render(<PanelEmptyState scope="thread" openTabs={[]} onOpen={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /add|new tab|\+/i })).not.toBeInTheDocument();
  });

  it("shows the mcode keycap for an openable type", () => {
    render(<PanelEmptyState scope="threadless" openTabs={[]} onOpen={vi.fn()} />);
    // Terminal binds to mod+j → "Ctrl+J" on non-mac.
    const terminal = screen.getByTestId("panel-card-terminal");
    expect(terminal.querySelector("kbd")).toBeInTheDocument();
  });
});
