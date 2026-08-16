import { describe, expect, it } from "vitest";
import {
  InMemoryPtyHostProtocol,
  PTY_HOST_MAX_RETAINED_RECORDS,
  PtyHostEventSchema,
  PtyHostServerMessageSchema,
  parsePtyHostEvent,
} from "../pty-host-protocol.js";

const UUID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";

describe("PTY host v1 protocol", () => {
  it("accepts a generation-bound child-inspection result", () => {
    expect(
      PtyHostEventSchema().parse({
        contractVersion: 1,
        kind: "children",
        sessionId: UUID,
        hostGeneration: "7",
        hasChildren: true,
      }),
    ).toEqual({
      contractVersion: 1,
      kind: "children",
      sessionId: UUID,
      hostGeneration: "7",
      hasChildren: true,
    });
  });

  it("validates host generation before dispatch for child inspection", () => {
    const message = {
      contractVersion: 1,
      kind: "inspectChildren",
      sessionId: UUID,
      hostGeneration: "7",
    } as const;
    expect(PtyHostServerMessageSchema().parse(message)).toEqual(message);
    const protocol = new InMemoryPtyHostProtocol("7");
    expect(protocol.sendToHost(message)).toEqual(message);
    expect(() => new InMemoryPtyHostProtocol("8").sendToHost(message)).toThrow(
      /generation/i,
    );
  });

  it("rejects oversized decoded payloads and environment messages", () => {
    expect(() =>
      PtyHostEventSchema().parse({
        contractVersion: 1,
        kind: "output",
        sessionId: UUID,
        hostGeneration: "7",
        outputSeq: "1",
        dataBase64: Buffer.alloc(65_537).toString("base64"),
      }),
    ).toThrow();
    expect(() =>
      PtyHostServerMessageSchema().parse({
        contractVersion: 1,
        kind: "create",
        sessionId: UUID,
        hostGeneration: "7",
        scope: { kind: "workspace", workspaceId: UUID },
        executable: "pwsh.exe",
        arguments: [],
        cwd: "C:\\repo",
        cols: 80,
        rows: 24,
        env: Array.from({ length: 257 }, (_, index) => ({ name: `V_${index}`, value: "x" })),
      }),
    ).toThrow();
  });

  it("provides a bounded recovery trace through the in-memory seam", () => {
    const protocol = new InMemoryPtyHostProtocol("7");
    const failure = {
      contractVersion: 1,
      kind: "failure",
      hostGeneration: "7",
      boundary: "output",
      recoverable: true,
      code: "HOST_UNHEALTHY",
    } as const;
    expect(protocol.receiveFromHost(failure)).toEqual(failure);
    expect(() => parsePtyHostEvent(failure, "8")).toThrow(/generation/i);
    expect(protocol.events()).toEqual([failure]);
  });

  it("rejects a duplicate output sequence with different bytes", () => {
    const protocol = new InMemoryPtyHostProtocol("7");
    const output = {
      contractVersion: 1,
      kind: "output",
      sessionId: UUID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("first").toString("base64"),
    } as const;

    expect(protocol.receiveFromHost(output)).toEqual(output);
    expect(protocol.receiveFromHost(output)).toEqual(output);
    expect(() =>
      protocol.receiveFromHost({
        ...output,
        dataBase64: Buffer.from("different").toString("base64"),
      }),
    ).toThrow(/duplicate output/i);
  });

  it("evicts the oldest retained protocol records", () => {
    const protocol = new InMemoryPtyHostProtocol("7");
    for (let index = 0; index <= PTY_HOST_MAX_RETAINED_RECORDS; index += 1) {
      protocol.receiveFromHost({
        contractVersion: 1,
        kind: "heartbeat",
        hostGeneration: "7",
        monotonicMs: index.toString(),
        activeSessions: 0,
        queueBytes: 0,
        rssBytes: "0",
      });
      protocol.sendToHost({
        contractVersion: 1,
        kind: "probe",
        hostGeneration: "7",
        nonce: `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`,
      });
    }

    expect(protocol.events()).toHaveLength(PTY_HOST_MAX_RETAINED_RECORDS);
    expect(protocol.events()[0]).toMatchObject({ monotonicMs: "1" });
    expect(protocol.messages()).toHaveLength(PTY_HOST_MAX_RETAINED_RECORDS);
    expect(protocol.messages()[0]).toMatchObject({ nonce: "11111111-1111-4111-8111-000000000001" });
  });

  it("accepts only the frozen host capability object", () => {
    const event = {
      contractVersion: 1,
      kind: "ready",
      hostGeneration: "7",
      platform: "windows",
      nativeAbi: "win32-x64-127",
      capabilities: {
        pty: "conpty",
        containment: "job-object",
        maxSessions: 20,
        protocolVersion: 1,
      },
    } as const;
    expect(PtyHostEventSchema().parse(event)).toEqual(event);
    expect(() =>
      PtyHostEventSchema().parse({ ...event, capabilities: ["conpty", "job-object"] }),
    ).toThrow();
    expect(() =>
      PtyHostEventSchema().parse({
        ...event,
        capabilities: { ...event.capabilities, maxSessions: 19 },
      }),
    ).toThrow();
  });

  it("uses the canonical executable and argument boundary", () => {
    const create = {
      contractVersion: 1,
      kind: "create",
      sessionId: UUID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: UUID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    } as const;
    expect(PtyHostServerMessageSchema().parse(create)).toEqual(create);
    expect(() =>
      PtyHostServerMessageSchema().parse({ ...create, executable: "tools/pwsh.exe" }),
    ).toThrow();
  });
});
