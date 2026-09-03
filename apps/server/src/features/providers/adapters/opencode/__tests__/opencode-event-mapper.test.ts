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

  it("maps standalone part deltas to text deltas", () => {
    const delta = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello" },
    }, CTX);
    expect(delta.disposition).toBe("mapped");
    expect(delta.events[0]).toMatchObject({ type: "textDelta", delta: "hello" });

    const userDelta = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_user", partID: "prt_9", field: "text", delta: "do the thing" },
    }, { ...CTX, partRole: "user" });
    expect(userDelta.disposition).toBe("state-only");

    const nonText = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "reasoning", delta: "hmm" },
    }, CTX);
    expect(nonText.disposition).toBe("state-only");
  });

  it("ignores plugin lifecycle noise", () => {
    const added = mapOpenCodeEnvelope({ type: "plugin.added", properties: { plugin: "opencode-pty" } }, CTX);
    expect(added.disposition).toBe("ignored");
    expect(added.reason).toBe("noise:plugin.added");
  });

  it("ignores catalog, reference, and integration lifecycle noise", () => {
    for (const type of ["catalog.updated", "reference.updated", "integration.updated"]) {
      const out = mapOpenCodeEnvelope({ type, properties: {} }, CTX);
      expect(out.disposition).toBe("ignored");
      expect(out.reason).toBe(`noise:${type}`);
    }
  });

  it("forwards each text slice exactly once across deltas and snapshots", () => {
    const forwarded = new Map<string, string>();
    const ctx = { ...CTX, forwardedText: forwarded };
    const delta = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "abcdef" },
    }, ctx);
    expect(delta.events[0]).toMatchObject({ type: "textDelta", delta: "abcdef" });
    const snapshot = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: { type: "text", id: "prt_1", messageID: "msg_1", text: "abcdef" } },
    }, ctx);
    expect(snapshot.disposition).toBe("state-only");
    expect(snapshot.events).toHaveLength(0);
  });

  it("maps the session.next streaming family", () => {
    const text = mapOpenCodeEnvelope({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", textID: "txt_1", delta: "hi" },
    }, CTX);
    expect(text.events[0]).toMatchObject({ type: "textDelta", delta: "hi" });

    const called = mapOpenCodeEnvelope({
      type: "session.next.tool.called",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", callID: "c1", tool: "read", input: { path: "a" } },
    }, CTX);
    expect(called.events[0]).toMatchObject({ type: "toolUse", toolCallId: "c1" });

    const ended = mapOpenCodeEnvelope({
      type: "session.next.step.ended",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "end_turn", cost: 0.01, tokens: { input: 10, output: 5 } },
    }, CTX);
    expect(ended.events[0]).toMatchObject({ type: "turnComplete", tokensIn: 10, tokensOut: 5 });

    const asked = mapOpenCodeEnvelope({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "edit" },
    }, CTX);
    expect(asked.disposition).toBe("diagnostic");
    expect(asked.reason).toBe("permission-asked");
  });
});
