import { describe, expect, it } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import {
  removeSelectedTextComment,
  saveSelectedTextComment,
} from "./composer-selected-text-comments";

const first: SelectedTextComment = {
  id: "11111111-1111-4111-8111-111111111111",
  displayNumber: 1,
  source: { threadId: "thread-1", messageId: "message-1", sourceRole: "assistant", start: 0, end: 5, quote: "First" },
  note: "First note",
  mentions: [],
};

const second: SelectedTextComment = {
  ...first,
  id: "22222222-2222-4222-8222-222222222222",
  displayNumber: 99,
  source: { ...first.source, messageId: "message-2", quote: "Second" },
  note: "Second note",
};

describe("ComposerDraft selected-text comments", () => {
  it("assigns creation-order numbers and preserves the number when a saved card is edited", () => {
    const created = saveSelectedTextComment([], first);
    const withSecond = saveSelectedTextComment(created, second);
    const edited = saveSelectedTextComment(withSecond, { ...first, note: "Edited note", displayNumber: 44 });

    expect(withSecond.map((comment) => comment.displayNumber)).toEqual([1, 2]);
    expect(edited).toMatchObject([
      { id: first.id, displayNumber: 1, note: "Edited note" },
      { id: second.id, displayNumber: 2 },
    ]);
  });

  it("removes one saved card and renumbers only the surviving cards", () => {
    const result = removeSelectedTextComment([first, { ...second, displayNumber: 2 }], first.id);

    expect(result).toMatchObject([{ id: second.id, displayNumber: 1 }]);
  });
});
