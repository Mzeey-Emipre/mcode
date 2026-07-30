import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityToken } from "../EntityToken";

describe("EntityToken command invocations", () => {
  it("matches autocomplete icons while omitting the slash from rendered text", () => {
    const { container } = render(
      <div>
        <EntityToken kind="skill" label="/review" invocation />
        <EntityToken kind="command" label="/review" invocation />
        <EntityToken kind="plugin" label="/figma" invocation />
        <EntityToken kind="mcode" label="/plan" invocation />
      </div>,
    );

    expect(container.querySelector('[data-entity-token="skill"]')).toHaveTextContent("review");
    expect(container.querySelector('[data-entity-token="command"]')).toHaveTextContent("review");
    expect(container.querySelector('[data-entity-token="plugin"]')).toHaveTextContent("figma");
    expect(container.querySelector('[data-entity-token="mcode"]')).toHaveTextContent("plan");
    expect(container.querySelector('[data-entity-token="skill"] [data-entity-icon="skill"]')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="command"] [data-entity-icon="command"]')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="plugin"] [data-entity-icon="plugin"]')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="mcode"] [data-entity-icon="mcode"]')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="skill"] .lucide-badge-check')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="command"] .lucide-square-terminal')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="plugin"] .lucide-plug')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="mcode"] .lucide-list-todo')).toBeInTheDocument();
    expect(container.querySelector('[data-entity-token="skill"]')).toHaveClass("text-[length:inherit]");
  });
});

describe("EntityToken inline references", () => {
  it("renders plugin mentions as frameless inline references", () => {
    const { container } = render(
      <EntityToken kind="plugin" label="@impeccable" tone="composer" />,
    );

    const token = container.querySelector('[data-entity-token="plugin"]');

    expect(token).toHaveClass("text-primary");
    expect(token).not.toHaveClass("h-5", "rounded-md", "px-1.5", "bg-muted/80");
    expect(token).toHaveTextContent("impeccable");
    expect(token?.querySelector(".lucide-plug")).toBeInTheDocument();
  });

  it("renders file and agent mentions with the same frameless style", () => {
    const { container } = render(
      <div>
        <EntityToken kind="file" label="@index.ts" tone="composer" filePath="index.ts" />
        <EntityToken kind="agent" label="@worker" tone="composer" />
      </div>,
    );

    for (const kind of ["file", "agent"]) {
      const token = container.querySelector(`[data-entity-token="${kind}"]`);

      expect(token).toHaveClass("text-primary");
      expect(token).not.toHaveClass(
        "h-5",
        "rounded-md",
        "px-1.5",
        "bg-muted",
        "bg-background",
        "ring-1",
      );
      expect(token?.querySelector(`[data-entity-icon="${kind}"]`)).toHaveClass("text-current");
    }
  });
});
