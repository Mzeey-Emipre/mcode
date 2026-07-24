/** Tests for row presentation and icon correctness in SlashCommandPopup. */
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
  { id: "mcode:goal", name: "goal", description: "Manage the active goal", namespace: "mcode", capabilityKind: "mcode", nativeId: "goal" },
  { id: "mcode:plan", name: "plan", description: "Manage the plan", namespace: "mcode", capabilityKind: "mcode", nativeId: "plan" },
  { id: "mcode:ultra", name: "ultra", description: "Use ultra reasoning", namespace: "mcode", capabilityKind: "mcode", nativeId: "ultra" },
  { id: "mcode:compact", name: "compact", description: "Compact context", namespace: "mcode", capabilityKind: "mcode", nativeId: "compact" },
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

function renderDuplicateSkillPopup() {
  const commands: Command[] = [
    {
      id: "skill:shared:grill-with-docs",
      name: "grill-with-docs",
      description: "Shared interviewing workflow",
      namespace: "skill",
      capabilityKind: "skill",
      nativeId: "C:/Users/test/.agents/skills/grill-with-docs/SKILL.md",
    },
    {
      id: "skill:project:grill-with-docs",
      name: "grill-with-docs",
      description: "Project interviewing workflow",
      namespace: "skill",
      capabilityKind: "skill",
      nativeId: "C:/workspace/project/.codex/skills/grill-with-docs/SKILL.md",
    },
  ];

  return render(
    <SlashCommandPopup
      state={{ kind: "ready", items: commands }}
      selectedIndex={0}
      anchorRect={makeAnchorRect()}
      workspacePath="C:/workspace/project"
      onSelect={() => {}}
      onDismiss={() => {}}
      onRetry={() => {}}
    />,
  );
}

describe("SlashCommandPopup row presentation", () => {
  it("renders duplicate skill rows directly and tags only the project copy", () => {
    renderDuplicateSkillPopup();

    expect(screen.queryByTestId(/slash-command-group/)).not.toBeInTheDocument();
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();

    const rows = screen.getAllByRole("option", { name: /grill-with-docs/ });
    expect(within(rows[0]).queryByText("Shared")).not.toBeInTheDocument();
    expect(within(rows[1]).getByText("Project")).toBeInTheDocument();
    expect(rows[0]).toHaveClass("h-10");
    expect(rows[0].querySelector(".lucide-badge-check")).not.toBeNull();

    const content = within(rows[0]).getByText("grill-with-docs").parentElement;
    expect(content).toHaveClass("items-baseline");
    expect(content).toContainElement(within(rows[0]).getByText("Shared interviewing workflow"));
  });

  it("renders rows without namespace headings", () => {
    renderPopup();
    expect(screen.queryByTestId(/slash-command-group/)).not.toBeInTheDocument();
    expect(screen.queryByText("Commands")).not.toBeInTheDocument();
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /deploy/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /my-skill/ })).toBeInTheDocument();
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

  it("places capability titles and descriptions on one row", () => {
    renderPopup();

    const pluginRow = screen.getByRole("option", { name: /A plugin skill/ });
    const title = within(pluginRow).getByText("use");
    const description = within(pluginRow).getByText("A plugin skill");
    const content = title.parentElement;
    expect(content).toBe(description.parentElement);
    expect(content).toHaveClass("items-baseline");
  });

  it("fades overflowing descriptions instead of showing an ellipsis", () => {
    renderPopup();

    const description = screen.getByText("A plugin skill");
    expect(description).toHaveClass("overflow-hidden", "whitespace-nowrap");
    expect(description).not.toHaveClass("truncate");
    expect(description).toHaveStyle({
      maskImage: "linear-gradient(to right, black calc(100% - 2.5rem), transparent)",
    });
  });

  it("keeps slash syntax on genuine commands", () => {
    renderPopup();

    const commandRow = screen.getByRole("option", { name: /Deploy command/ });
    expect(within(commandRow).getByText("/deploy")).toBeInTheDocument();
  });
});

describe("SlashCommandPopup capability icons", () => {
  it("skills render a fixed neutral BadgeCheck icon", () => {
    renderPopup();
    const skillRow = screen.getByRole("option", { name: /my-skill/ });
    expect(skillRow.querySelector(".lucide-badge-check")).not.toBeNull();
  });

  it("command namespace renders a square-terminal SVG", () => {
    renderPopup();
    const commandRow = screen.getByRole("option", { name: /deploy/ });
    const terminalIcon = commandRow.querySelector(".lucide-square-terminal");
    expect(terminalIcon).not.toBeNull();
  });

  it("native plugin entries render a Plug icon", () => {
    renderPopup();
    const pluginRow = screen.getByRole("option", { name: /A native plugin/ });
    expect(pluginRow.querySelector(".lucide-plug")).not.toBeNull();
  });

  it("plugin-provided skills remain skill entries", () => {
    renderPopup();
    const pluginSkillRow = screen.getByRole("option", { name: /A plugin skill/ });
    expect(pluginSkillRow.querySelector(".lucide-badge-check")).not.toBeNull();
    expect(pluginSkillRow.querySelector(".lucide-plug")).toBeNull();
  });

  it("command namespace does not render a skill icon", () => {
    renderPopup();
    const commandRow = screen.getByRole("option", { name: /deploy/ });
    expect(commandRow.querySelector(".lucide-badge-check")).toBeNull();
  });

  it("skill namespace does not render a command icon", () => {
    renderPopup();
    const skillRow = screen.getByRole("option", { name: /my-skill/ });
    const terminalIcon = skillRow.querySelector(".lucide-square-terminal");
    expect(terminalIcon).toBeNull();
  });

  it.each([
    ["goal", "lucide-target"],
    ["plan", "lucide-list-todo"],
    ["ultra", "lucide-gauge"],
    ["compact", "lucide-minimize-2"],
  ])("renders the accepted semantic icon for %s", (name, iconClass) => {
    renderPopup();
    const row = screen.getByRole("option", { name: new RegExp(name) });
    expect(row.querySelector(`.${iconClass}`)).not.toBeNull();
  });
});
