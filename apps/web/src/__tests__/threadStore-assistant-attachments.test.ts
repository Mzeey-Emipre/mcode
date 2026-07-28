import type { AgentEvent } from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTestThreadMessages,
  resetThreadStoreForTests,
} from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("threadStore assistant attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadStoreForTests({ currentThreadId: "thread-images" });
  });

  it("keeps a session.message with attachments and empty content", () => {
    const attachment = {
      id: "img-1",
      name: "generated.png",
      mimeType: "image/png",
      sizeBytes: 128,
    };

    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "thread-images", messageId: "msg-1",
      content: "",
      tokens: null,
      attachments: [attachment] } satisfies AgentEvent);

    expect(getTestThreadMessages("thread-images")).toEqual([
      expect.objectContaining({
        id: "msg-1",
        role: "assistant",
        content: "",
        attachments: [attachment],
      }),
    ]);
  });
});
