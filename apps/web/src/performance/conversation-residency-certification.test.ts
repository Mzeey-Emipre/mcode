import { describe, expect, it } from "vitest";
import { CONVERSATION_REVISION_GUARD } from "@/features/conversation/hydration/conversation-revision";
import {
  MATERIAL_REVISION_SERIALIZATION_BYTES,
  createRepresentativeConversation,
  runConversationResidencyCertification,
  selectConversationRevisionGuard,
} from "./conversation-residency-certification";

describe("conversation residency certification", () => {
  it("uses stable representative message identities and content sizes", () => {
    const messages = createRepresentativeConversation("thread-a", 100);

    expect(messages).toHaveLength(100);
    expect(messages[0]).toMatchObject({
      id: "thread-a-message-1",
      thread_id: "thread-a",
      sequence: 1,
    });
    expect(messages.at(-1)?.sequence).toBe(100);
    expect(messages[0]?.content).toHaveLength(16_000);
  });

  it("selects the numeric guard only at a material full-state allocation", () => {
    expect(selectConversationRevisionGuard(MATERIAL_REVISION_SERIALIZATION_BYTES - 1)).toBe(
      "serialized",
    );
    expect(selectConversationRevisionGuard(MATERIAL_REVISION_SERIALIZATION_BYTES)).toBe(
      "numeric",
    );
    expect(CONVERSATION_REVISION_GUARD).toBe("numeric");
  });

  it("rejects an unbounded sample count", () => {
    expect(() => runConversationResidencyCertification(2)).toThrow(
      "samples must be an integer from 3 through 50",
    );
  });
});
