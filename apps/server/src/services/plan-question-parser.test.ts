import { describe, it, expect } from "vitest";
import { PlanQuestionParser } from "../services/plan-question-parser.js";

const VALID_BLOCK = `
\`\`\`plan-questions
[
  {
    "id": "q1",
    "category": "AUTH",
    "question": "How should auth work?",
    "options": [
      { "id": "o1", "title": "JWT", "description": "Use JWT tokens.", "recommended": true },
      { "id": "o2", "title": "Session", "description": "Use server sessions." }
    ]
  }
]
\`\`\`
`;

describe("PlanQuestionParser", () => {
  it("returns null when block is incomplete", () => {
    const parser = new PlanQuestionParser();
    expect(parser.feed("```plan-questions\n[")).toBeNull();
  });

  it("returns questions when a complete valid block is fed at once", () => {
    const parser = new PlanQuestionParser();
    const result = parser.feed(VALID_BLOCK);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("q1");
    expect(result![0].category).toBe("AUTH");
    expect(result![0].options).toHaveLength(2);
    expect(result![0].options[0].recommended).toBe(true);
  });

  it("returns questions when block is fed in streaming chunks", () => {
    const parser = new PlanQuestionParser();
    const chunks = VALID_BLOCK.match(/.{1,10}/g)!;
    let result = null;
    for (const chunk of chunks) {
      result = parser.feed(chunk);
      if (result) break;
    }
    expect(result).not.toBeNull();
    expect(result![0].id).toBe("q1");
  });

  it("returns null and hasQuestions stays false for malformed JSON", () => {
    const parser = new PlanQuestionParser();
    const result = parser.feed("```plan-questions\n{ bad json }\n```");
    expect(result).toBeNull();
    expect(parser.hasQuestions).toBe(false);
  });

  it("returns null for schema validation failure (too few options)", () => {
    const parser = new PlanQuestionParser();
    const bad = '```plan-questions\n[{"id":"q1","category":"X","question":"?","options":[{"id":"o1","title":"A","description":"B"}]}]\n```';
    expect(parser.feed(bad)).toBeNull();
    expect(parser.hasQuestions).toBe(false);
  });

  it("returns null for empty array (no questions needed)", () => {
    const parser = new PlanQuestionParser();
    expect(parser.feed("```plan-questions\n[]\n```")).toBeNull();
    expect(parser.hasQuestions).toBe(false);
  });

  it("only extracts questions once even if called again after success", () => {
    const parser = new PlanQuestionParser();
    parser.feed(VALID_BLOCK);
    expect(parser.hasQuestions).toBe(true);
    expect(parser.feed(VALID_BLOCK)).toBeNull();
  });

  it("rejects batches with more than 15 questions", () => {
    const parser = new PlanQuestionParser();
    const questions = Array.from({ length: 16 }, (_, i) => ({
      id: `q${i}`,
      category: "X",
      question: "?",
      options: [
        { id: "o1", title: "A", description: "desc" },
        { id: "o2", title: "B", description: "desc" },
      ],
    }));
    const block = "```plan-questions\n" + JSON.stringify(questions) + "\n```";
    expect(parser.feed(block)).toBeNull();
    expect(parser.hasQuestions).toBe(false);
  });

  it("ignores text before and after the block", () => {
    const parser = new PlanQuestionParser();
    const result = parser.feed(`Some preamble text.\n${VALID_BLOCK}\nSome trailing text.`);
    expect(result).not.toBeNull();
    expect(result![0].id).toBe("q1");
  });
});
