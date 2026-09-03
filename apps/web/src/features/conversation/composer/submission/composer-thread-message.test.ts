import { describe, expect, it, vi } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import { createDefaultComposerAgentSelection } from "../draft/composer-selection-state";

const threadActions = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: () => threadActions,
  },
}));

import { sendComposerThreadMessage } from "./composer-thread-message";

const comment: SelectedTextComment = {
  id: "550e8400-e29b-41d4-a716-446655440003",
  displayNumber: 1,
  source: {
    threadId: "thread-1",
    messageId: "completed-user-message",
    sourceRole: "user",
    start: 1,
    end: 3,
    quote: "😀",
  },
  note: "Explain this choice.",
  mentions: [],
};

describe("sendComposerThreadMessage", () => {
  it("sends existing-thread text and selected-text comment metadata together", async () => {
    threadActions.sendMessage.mockResolvedValue(true);

    await sendComposerThreadMessage("thread-1", {
      content: "Explain the tradeoff.",
      displayContent: "Explain the tradeoff.",
      attachments: [],
      selection: createDefaultComposerAgentSelection(),
      mentions: [],
      selectedTextComments: [comment],
    });

    const sent = threadActions.sendMessage.mock.calls[0];
    expect(sent?.[0]).toBe("thread-1");
    expect(sent?.[1]).toBe("Explain the tradeoff.");
    expect(sent?.[19]).toEqual([comment]);
  });
});
