import { describe, expect, it } from "vitest";
import { InMemoryPtyHostAdapter } from "../in-memory-pty-host-adapter.js";

const UUID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const SECOND_UUID = "12345678-abcd-4abc-8abc-abcdefabcdef";

const createRequest = (sessionId = UUID) => ({
  sessionId,
  hostGeneration: "7",
  launch: {
    requestedProfileId: "automatic" as const,
    resolvedProfile: {
      id: "certified:windows-powershell-7" as const,
      name: "PowerShell 7",
      executable: "pwsh.exe",
      arguments: [],
      source: "certified" as const,
      platform: "windows" as const,
    },
    scope: { kind: "workspace" as const, workspaceId: UUID },
    arguments: [],
  },
  cwd: "C:\\repo",
  protectedEnv: [],
  cols: 80,
  rows: 24,
});

describe("InMemoryPtyHostAdapter", () => {
  it("runs create, command, output, inspection, and close through the strict host seam", async () => {
    const adapter = new InMemoryPtyHostAdapter("7");
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.kind));
    await expect(adapter.start()).resolves.toEqual({ hostGeneration: "7", state: "healthy" });
    await expect(
      adapter.create(createRequest()),
    ).resolves.toMatchObject({ state: "running", containment: "job-object" });
    await adapter.send({ sessionId: UUID, hostGeneration: "7", attachmentEpoch: "1", commandSeq: "1", kind: "input", data: new TextEncoder().encode("echo ok") });
    adapter.emitOutput(UUID, new TextEncoder().encode("ok\r\n"));
    await expect(adapter.inspectChildren(UUID, "7")).resolves.toEqual({ hasChildren: false });
    await adapter.close({ sessionId: UUID, hostGeneration: "7", closeSeq: "2", reason: "user" });
    expect(events).toEqual([
      "ready",
      "containment",
      "running",
      "commandAck",
      "output",
      "exit",
    ]);
  });

  it("rejects stale generation before child inspection", async () => {
    const adapter = new InMemoryPtyHostAdapter("7");
    await adapter.start();
    await adapter.create(createRequest());
    await expect(adapter.inspectChildren(UUID, "8")).rejects.toThrow(/generation/i);
  });

  it("rejects repeated startup, duplicate sessions, and invalid command sequences", async () => {
    const adapter = new InMemoryPtyHostAdapter("7");
    await adapter.start();
    await expect(adapter.start()).rejects.toThrow(/already started/i);
    await adapter.create(createRequest());
    await expect(adapter.create(createRequest())).rejects.toThrow(/already exists/i);
    await expect(
      adapter.send({
        sessionId: UUID,
        hostGeneration: "7",
        attachmentEpoch: "1",
        commandSeq: "not-a-sequence",
        kind: "input",
        data: new Uint8Array([0x61]),
      }),
    ).rejects.toThrow(/u64/i);
  });

  it("emits exits for open sessions and releases listeners during shutdown", async () => {
    const adapter = new InMemoryPtyHostAdapter("7");
    const events: string[] = [];
    adapter.subscribe((event) => events.push(`${event.kind}:${"sessionId" in event ? event.sessionId : "host"}`));
    await adapter.start();
    await adapter.create(createRequest());
    await adapter.create(createRequest(SECOND_UUID));

    await adapter.shutdown();
    expect(events.slice(-2)).toEqual([`exit:${UUID}`, `exit:${SECOND_UUID}`]);

    await adapter.start();
    expect(events.slice(-1)).toEqual([`exit:${SECOND_UUID}`]);
  });
});
