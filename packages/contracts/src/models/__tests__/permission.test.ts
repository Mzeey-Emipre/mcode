import { describe, expect, it } from "vitest";
import {
  PermissionRequestSchema,
  PermissionResponseAnswersSchema,
  WS_METHODS,
} from "../../index.js";

describe("provider-neutral question permissions", () => {
  it("preserves bounded question metadata and exact custom reply text", () => {
    const request = PermissionRequestSchema().parse({
      requestId: "que_1",
      threadId: "thread-1",
      toolName: "Question",
      input: {},
      questions: [{
        header: "Deploy",
        question: "Where should this go?",
        options: [{ label: "Production", description: "Ship now" }],
        multiple: false,
        custom: true,
      }],
    });
    expect(request.questions?.[0]).toEqual({
      header: "Deploy",
      question: "Where should this go?",
      options: [{ label: "Production", description: "Ship now" }],
      multiple: false,
      custom: true,
    });

    const params = WS_METHODS()["permission.respond"].params.parse({
      requestId: "que_1",
      decision: "allow",
      answers: [[" staging "]],
    });
    expect(params.answers).toEqual([[" staging "]]);
  });

  it("rejects blank or oversized answer identities before provider ingress", () => {
    expect(PermissionResponseAnswersSchema().safeParse([["  "]]).success).toBe(false);
    expect(PermissionResponseAnswersSchema().safeParse([["x".repeat(101)]]).success).toBe(false);
    expect(WS_METHODS()["permission.respond"].params.safeParse({
      requestId: "que_1",
      decision: "allow",
      answers: Array.from({ length: 11 }, () => ["Yes"]),
    }).success).toBe(false);
  });
});
