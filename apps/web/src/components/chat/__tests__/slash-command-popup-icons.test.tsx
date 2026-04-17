/**
 * Tests for icon and badge style correctness in SlashCommandPopup.
 *
 * - command namespace: amber (primary) badge, Terminal icon
 * - skill namespace: Sparkles icon (not Terminal)
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeAll } from "vitest";
import { SlashCommandPopup } from "../SlashCommandPopup";
import type { Command } from "../useSlashCommand";

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
  { name: "deploy", description: "Deploy command", namespace: "command" },
  { name: "my-skill", description: "A skill", namespace: "skill" },
];

function renderPopup() {
  return render(
    <SlashCommandPopup
      isOpen={true}
      isLoading={false}
      items={COMMANDS}
      selectedIndex={0}
      anchorRect={makeAnchorRect()}
      onSelect={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("SlashCommandPopup namespace badge colors", () => {
  it("command badge does NOT contain sky-500", () => {
    renderPopup();
    const commandRow = screen.getByRole("option", { name: /deploy/ });
    // The badge is the direct last span child of the button (ml-auto class)
    const badge = commandRow.querySelector(":scope > span:last-child");
    expect(badge?.className).not.toMatch(/sky-500/);
  });

  it("command badge contains text-primary (amber brand color)", () => {
    renderPopup();
    const commandRow = screen.getByRole("option", { name: /deploy/ });
    const badge = commandRow.querySelector(":scope > span:last-child");
    expect(badge?.className).toContain("text-primary");
  });
});

describe("SlashCommandPopup namespace icons", () => {
  it("skill namespace renders a lucide-sparkles SVG", () => {
    renderPopup();
    const skillRow = screen.getByRole("option", { name: /my-skill/ });
    const sparklesIcon = skillRow.querySelector(".lucide-sparkles");
    expect(sparklesIcon).not.toBeNull();
  });

  it("command namespace renders a lucide-terminal SVG", () => {
    renderPopup();
    const commandRow = screen.getByRole("option", { name: /deploy/ });
    const terminalIcon = commandRow.querySelector(".lucide-terminal");
    expect(terminalIcon).not.toBeNull();
  });

  it("command namespace does NOT render a lucide-sparkles SVG", () => {
    renderPopup();
    const commandRow = screen.getByRole("option", { name: /deploy/ });
    const sparklesIcon = commandRow.querySelector(".lucide-sparkles");
    expect(sparklesIcon).toBeNull();
  });

  it("skill namespace does NOT render a lucide-terminal SVG", () => {
    renderPopup();
    const skillRow = screen.getByRole("option", { name: /my-skill/ });
    const terminalIcon = skillRow.querySelector(".lucide-terminal");
    expect(terminalIcon).toBeNull();
  });
});
