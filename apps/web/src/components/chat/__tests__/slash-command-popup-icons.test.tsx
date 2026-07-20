/** Tests for source grouping and icon correctness in SlashCommandPopup. */
import { render, screen, within } from "@testing-library/react";
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
  { id: "command:deploy", name: "deploy", description: "Deploy command", namespace: "command", capabilityKind: "providerCommand", nativeId: "deploy" },
  { id: "skill:my-skill", name: "my-skill", description: "A skill", namespace: "skill", capabilityKind: "skill", nativeId: "my-skill" },
  { id: "skill:figma:use", name: "figma:use", description: "A plugin skill", namespace: "plugin", capabilityKind: "skill", nativeId: "figma:use" },
  { id: "plugin:browser", name: "Browser", description: "A native plugin", namespace: "plugin", capabilityKind: "plugin", nativeId: "browser@openai-bundled", mentionPath: "plugin://browser@openai-bundled" },
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

  it("shows capability titles without slash or plugin prefixes", () => {
    renderPopup();

    const skillRow = screen.getByRole("option", { name: /my-skill/ });
    expect(within(skillRow).getByText("my-skill")).toBeInTheDocument();
    expect(within(skillRow).queryByText("/my-skill")).not.toBeInTheDocument();

    const pluginRow = screen.getByRole("option", { name: /A plugin skill/ });
    expect(within(pluginRow).getByText("use")).toBeInTheDocument();
    expect(within(pluginRow).queryByText("/figma:use")).not.toBeInTheDocument();
  });

  it("stacks capability titles above their descriptions", () => {
    renderPopup();

    const pluginRow = screen.getByRole("option", { name: /A plugin skill/ });
    const title = within(pluginRow).getByText("use");
    const description = within(pluginRow).getByText("A plugin skill");
    const content = title.closest(".flex-col");
    expect(content).toBe(description.parentElement);
  });

  it("fades overflowing descriptions instead of showing an ellipsis", () => {
    renderPopup();

    const description = screen.getByText("A plugin skill");
    expect(description).toHaveClass("overflow-hidden", "whitespace-nowrap");
    expect(description).not.toHaveClass("truncate");
    expect(description).toHaveStyle({
      maskImage: "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
    });
  });

  it("keeps slash syntax on genuine commands", () => {
    renderPopup();

    const commandRow = screen.getByRole("option", { name: /Deploy command/ });
    expect(within(commandRow).getByText("/deploy")).toBeInTheDocument();
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

  it("native plugin entries render a blocks SVG", () => {
    renderPopup();
    const pluginRow = screen.getByRole("option", { name: /A native plugin/ });
    expect(pluginRow.querySelector(".lucide-blocks")).not.toBeNull();
  });

  it("plugin-provided skills remain skill entries", () => {
    renderPopup();
    const pluginSkillRow = screen.getByRole("option", { name: /A plugin skill/ });
    expect(pluginSkillRow.querySelector(".lucide-sparkles")).not.toBeNull();
    expect(pluginSkillRow.querySelector(".lucide-blocks")).toBeNull();
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
