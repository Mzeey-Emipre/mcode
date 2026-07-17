import { describe, expect, it } from "vitest";
import { resolveComposerCapabilities } from "../composer-capabilities";

describe("resolveComposerCapabilities", () => {
  it.each([
    {
      name: "Claude Opus",
      providerId: "claude",
      modelId: "claude-opus-4-7",
      expected: ["plan:Plan:/plan", "goal:Goal:/goal", "orchestration:Ultracode:/ultracode"],
    },
    {
      name: "Claude Haiku",
      providerId: "claude",
      modelId: "claude-haiku-4-5",
      expected: ["plan:Plan:/plan", "goal:Goal:/goal"],
    },
    {
      name: "Codex Sol",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      expected: ["plan:Plan:/plan", "goal:Goal:/goal", "orchestration:Ultra:/ultra"],
    },
    {
      name: "Codex Luna",
      providerId: "codex",
      modelId: "gpt-5.6-luna",
      expected: ["plan:Plan:/plan", "goal:Goal:/goal"],
    },
    {
      name: "Cursor",
      providerId: "cursor",
      modelId: "cursor-auto",
      expected: ["plan:Plan:/plan"],
    },
    {
      name: "Copilot",
      providerId: "copilot",
      modelId: "gpt-4.1",
      expected: [],
    },
  ])("resolves $name capabilities from one provider/model matrix", ({ providerId, modelId, expected }) => {
    const capabilities = resolveComposerCapabilities({ providerId, modelId });

    expect(
      capabilities.map(
        (capability) =>
          `${capability.id}:${capability.label}:/${capability.slashCommand}`,
      ),
    ).toEqual(expected);
  });

  it("keeps provider-neutral Plan discovery when no provider is selected", () => {
    expect(resolveComposerCapabilities({}).map((capability) => capability.id)).toEqual(["plan"]);
  });
});
