/**
 * Tests for the CommandRow selection indicator in SlashCommandPopup.
 *
 * The selected row should use bg-accent as its only selection indicator.
 * The previous border-l-2 left-stripe must not appear on any row.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SlashCommandPopup } from "../SlashCommandPopup";
import type { Command } from "../useSlashCommand";

// jsdom doesn't implement ResizeObserver or scrollIntoView. Capture originals
// so the polyfills are reverted after the suite to avoid leaking into other
// tests that share the same jsdom instance.
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.scrollIntoView = () => {};
});

afterAll(() => {
  if (originalResizeObserver === undefined) {
    // @ts-expect-error -- intentional cleanup of polyfilled global
    delete globalThis.ResizeObserver;
  } else {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

/** Minimal DOMRect-like object for anchorRect. */
function makeAnchorRect(): DOMRect {
  return {
    top: 400,
    bottom: 420,
    left: 0,
    right: 320,
    width: 320,
    height: 20,
    x: 0,
    y: 400,
    toJSON() {
      return {};
    },
  };
}

const COMMANDS: Command[] = [
  { name: "foo", description: "First command", namespace: "command" },
  { name: "bar", description: "Second command", namespace: "skill" },
  { name: "baz", description: "Third command", namespace: "mcode" },
];

function renderPopup(selectedIndex: number) {
  return render(
    <SlashCommandPopup
      isOpen={true}
      isLoading={false}
      items={COMMANDS}
      selectedIndex={selectedIndex}
      anchorRect={makeAnchorRect()}
      onSelect={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("SlashCommandPopup selection indicator", () => {
  it("selected row has bg-accent class", () => {
    renderPopup(0);
    const selectedRow = screen.getByRole("option", { name: /foo/ });
    expect(selectedRow.className).toContain("bg-accent");
  });

  it("selected row has no border-l class", () => {
    renderPopup(0);
    const selectedRow = screen.getByRole("option", { name: /foo/ });
    expect(selectedRow.className).not.toMatch(/border-l/);
  });

  it("unselected row has no border-l class", () => {
    renderPopup(0);
    const unselectedRow = screen.getByRole("option", { name: /bar/ });
    expect(unselectedRow.className).not.toMatch(/border-l/);
  });

  it("selected row is marked aria-selected=true", () => {
    renderPopup(1);
    const selectedRow = screen.getByRole("option", { name: /bar/ });
    expect(selectedRow).toHaveAttribute("aria-selected", "true");
  });

  it("unselected rows are marked aria-selected=false", () => {
    renderPopup(1);
    const unselectedRow = screen.getByRole("option", { name: /foo/ });
    expect(unselectedRow).toHaveAttribute("aria-selected", "false");
  });
});
