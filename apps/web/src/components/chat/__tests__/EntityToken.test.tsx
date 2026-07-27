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
