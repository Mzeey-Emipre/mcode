import { describe, it, expect, vi } from "vitest";
import {
  buildCursorAskQuestionExtResponse,
  pickCursorAskQuestionOptionIds,
} from "../cursor-acp-ask-question.js";

describe("pickCursorAskQuestionOptionIds", () => {
  it("prefers options marked recommended", () => {
    const ids = pickCursorAskQuestionOptionIds({
      id: "q1",
      prompt: "Pick one",
      options: [
        { id: "a", label: "First" },
        { id: "b", label: "Second", recommended: true },
      ],
    });
    expect(ids).toEqual(["b"]);
  });

  it("falls back to label containing Recommended", () => {
    const ids = pickCursorAskQuestionOptionIds({
      options: [{ id: "x", label: "Recommended fix" }],
    });
    expect(ids).toEqual(["x"]);
  });

  it("uses the first labelled option without a recommended hint", () => {
    const ids = pickCursorAskQuestionOptionIds({
      options: [
        { id: "silent" },
        { id: "pick", label: "Use this path" },
      ],
    });
    expect(ids).toEqual(["pick"]);
  });

  it("falls back to the first id-bearing option", () => {
    const ids = pickCursorAskQuestionOptionIds({
      options: [{ id: "only" }],
    });
    expect(ids).toEqual(["only"]);
  });

  it("returns empty when no selectable ids exist", () => {
    expect(
      pickCursorAskQuestionOptionIds({
        options: [{ label: "no id" }],
      }),
    ).toEqual([]);
  });
});

describe("buildCursorAskQuestionExtResponse", () => {
  it('returns skipped outcome when autoAnswer is false', () => {
    const out = buildCursorAskQuestionExtResponse({ questions: [] }, false);
    expect(out.outcome).toEqual({
      outcome: "skipped",
      reason: expect.stringContaining("disabled auto answers"),
    });
  });

  it("fires onAutoSummary when answered", () => {
    const onAutoSummary = vi.fn();
    const out = buildCursorAskQuestionExtResponse(
      {
        questions: [
          {
            id: "q",
            prompt: "Deploy?",
            options: [{ id: "yes", label: "Yes", recommended: true }],
          },
        ],
      },
      true,
      onAutoSummary,
    );

    expect(out.outcome).toEqual({
      outcome: "answered",
      answers: [{ questionId: "q", selectedOptionIds: ["yes"] }],
    });
    expect(onAutoSummary).toHaveBeenCalledWith({
      lines: ["Deploy? → yes"],
      answers: [{ questionId: "q", selectedOptionIds: ["yes"] }],
    });
  });

  it("returns skipped when questions array is empty", () => {
    const out = buildCursorAskQuestionExtResponse({ questions: [] }, true);
    expect(out.outcome).toMatchObject({ outcome: "skipped" });
  });
});
