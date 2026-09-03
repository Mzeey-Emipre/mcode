import { describe, expect, it } from "vitest";
import { mapOpenCodeEnvelope } from "../opencode-event-mapper.js";

const CTX = { threadId: "thread-1", turnExecutionId: "11111111-1111-4111-8111-111111111111" };

describe("mapOpenCodeEnvelope", () => {
  it("maps text deltas in both envelope shapes", () => {
    const flat = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "text", id: "p1" }, delta: "hello" },
    }, CTX);
    expect(flat.disposition).toBe("mapped");
    expect(flat.events[0]).toMatchObject({ type: "textDelta", delta: "hello" });

    const wrapped = mapOpenCodeEnvelope({
      type: "bus",
      payload: { type: "message.part.updated", properties: { part: { type: "text", id: "p1" }, delta: "hi" } },
    }, CTX);
    expect(wrapped.disposition).toBe("mapped");
    expect(wrapped.events[0]).toMatchObject({ type: "textDelta", delta: "hi" });
  });

  it("maps tool running then completed states", () => {
    const use = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "tool", callID: "c1", tool: "read", state: { status: "running", input: { path: "a" } } } },
    }, CTX);
    expect(use.events[0]).toMatchObject({ type: "toolUse", toolCallId: "c1", toolName: "read" });

    const result = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: {}, output: "ok", title: "t", metadata: {}, time: { start: 1, end: 2 } } } },
    }, CTX);
    expect(result.events[0]).toMatchObject({ type: "toolResult", toolCallId: "c1", isError: false });
  });

  it("marks session.idle as completion and unknown types as bounded diagnostics", () => {
    const idle = mapOpenCodeEnvelope({ type: "session.idle", properties: { sessionID: "ses_1" } }, CTX);
    expect(idle.disposition).toBe("mapped");
    expect(idle.events[0]).toMatchObject({ type: "turnComplete" });

    const unknown = mapOpenCodeEnvelope({ type: "session.frobnicate", properties: {} }, CTX);
    expect(unknown.disposition).toBe("diagnostic");
    expect(unknown.reason).toBe("unknown-event-type");
  });

  it("ignores known noise with a reason and keeps lifecycle signals state-only", () => {
    expect(mapOpenCodeEnvelope({ type: "server.connected", properties: {} }, CTX).disposition).toBe("state-only");
    const noise = mapOpenCodeEnvelope({ type: "todo.updated", properties: {} }, CTX);
    expect(noise.disposition).toBe("ignored");
    expect(noise.reason).toBe("noise:todo.updated");
  });

  it("never turns user message parts into assistant deltas", () => {
    const userPart = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { type: "text", id: "p1", sessionID: "ses_1", messageID: "msg_user" },
        delta: "do the thing",
      },
    }, { ...CTX, partRole: "user" });
    expect(userPart.disposition).toBe("state-only");
    expect(userPart.events).toHaveLength(0);
  });
});
