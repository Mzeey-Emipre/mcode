/** Tests for source grouping and icon correctness in SlashCommandPopup. */
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
  { name: "figma:use", description: "A plugin skill", namespace: "plugin" },
];

function renderPopup() {
  return render(
    <SlashCommandPopup
      state={{ kind: "ready", items: COMMANDS }}
      selectedIndex={0}
      anchorRect={makeAnchorRect()}
      onSelect={() => {}}
      onDismiss={() => {}}
      onRetry={() => {}}
    />,
  );
}

describe("SlashCommandPopup source groups", () => {
  it("places commands under the Commands heading", () => {
    renderPopup();
    const group = screen.getByTestId("slash-command-group-command");
    expect(group).toHaveTextContent("Commands");
    expect(group).toContainElement(screen.getByRole("option", { name: /deploy/ }));
  });

  it("places skills under the Skills heading", () => {
    renderPopup();
    const group = screen.getByTestId("slash-command-group-skill");
    expect(group).toHaveTextContent("Skills");
    expect(group).toContainElement(screen.getByRole("option", { name: /my-skill/ }));
  });
});

describe("SlashCommandPopup namespace icons", () => {
  it("skill namespace renders a lucide-sparkles SVG", () => {
    renderPopup();
    const skillRow = screen.getByRole("option", { name: /my-skill/ });
    const sparklesIcon = skillRow.querySelector(".lucide-sparkles");
    expect(sparklesIcon).not.toBeNull();
  });

  it("command namespace renders a square-terminal SVG", () => {
    renderPopup();
    const commandRow = screen.getByRole("option", { name: /deploy/ });
    const terminalIcon = commandRow.querySelector(".lucide-square-terminal");
    expect(terminalIcon).not.toBeNull();
  });

  it("plugin namespace renders a blocks SVG", () => {
    renderPopup();
    const pluginRow = screen.getByRole("option", { name: /figma:use/ });
    expect(pluginRow.querySelector(".lucide-blocks")).not.toBeNull();
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
    const terminalIcon = skillRow.querySelector(".lucide-square-terminal");
    expect(terminalIcon).toBeNull();
  });
});
