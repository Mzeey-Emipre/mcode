import { render } from "@testing-library/react";
import type { Message } from "@/transport";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../MessageBubble";

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { threads: [] }) => unknown) => selector({ threads: [] }),
}));

vi.mock("@/stores/providerModelsStore", () => ({
  useProviderModelsStore: (selector: (state: { models: Record<string, never> }) => unknown) => selector({ models: {} }),
}));

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: () => false,
}));

function createUserMessage(): Message {
  return {
    id: "message-1",
    thread_id: "thread-1",
    role: "user",
    content: "Please /review this change",
    timestamp: "2026-07-28T12:00:00.000Z",
    mentions: [{
      id: "command:skill:review",
      kind: "command",
      label: "review",
      namespace: "skill",
      range: { start: 7, end: 14 },
    }],
  } as Message;
}

function createPluginMessage(): Message {
  return {
    id: "message-plugin",
    thread_id: "thread-1",
    role: "user",
    content: "@impeccable",
    timestamp: "2026-07-28T12:00:00.000Z",
    mentions: [{
      id: "plugin:impeccable",
      kind: "plugin",
      label: "impeccable",
      name: "Impeccable",
      path: "plugin://impeccable",
      range: { start: 0, end: 11 },
    }],
  } as Message;
}

describe("MessageBubble", () => {
  it("keeps a command mention in the standard user-message paragraph flow", () => {
    const { container } = render(<MessageBubble message={createUserMessage()} />);

    const text = container.querySelector('[data-entity-token="skill"]')?.closest("p");

    expect(text).toHaveClass("mb-2", "leading-relaxed", "whitespace-pre-wrap");
    expect(text).toHaveTextContent("Please review this change");
  });

  it("renders persisted plugin mentions with the frameless capability reference style", () => {
    const { container } = render(<MessageBubble message={createPluginMessage()} />);

    const token = container.querySelector('[data-entity-token="plugin"]');
    const text = token?.closest("p");

    expect(token).toHaveClass("text-primary");
    expect(token).not.toHaveClass("h-5", "rounded-md", "px-1.5");
    expect(token?.querySelector(".lucide-plug")).toBeInTheDocument();
    expect(text).toHaveClass("mb-2", "leading-relaxed", "whitespace-pre-wrap");
  });
});
