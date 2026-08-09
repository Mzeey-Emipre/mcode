import { describe, expect, it } from "vitest";
import { InMemoryPtyHostAdapter } from "./in-memory-pty-host-adapter.js";

const UUID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";

describe("InMemoryPtyHostAdapter", () => {
  it("runs create, command, output, inspection, and close through the strict host seam", async () => {
    const adapter = new InMemoryPtyHostAdapter("7");
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.kind));
    await expect(adapter.start()).resolves.toEqual({ hostGeneration: "7", state: "healthy" });
    await expect(
      adapter.create({
        sessionId: UUID,
        hostGeneration: "7",
        launch: {
          requestedProfileId: "automatic",
          resolvedProfile: {
            id: "certified:windows-powershell-7",
            name: "PowerShell 7",
            executable: "pwsh.exe",
            arguments: [],
            source: "certified",
            platform: "windows",
          },
          scope: { kind: "workspace", workspaceId: UUID },
          arguments: [],
        },
        cwd: "C:\\repo",
        protectedEnv: [],
        cols: 80,
        rows: 24,
      }),
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
    await adapter.create({
      sessionId: UUID,
      hostGeneration: "7",
      launch: {
        requestedProfileId: "automatic",
        resolvedProfile: { id: "certified:windows-powershell-7", name: "PowerShell 7", executable: "pwsh.exe", arguments: [], source: "certified", platform: "windows" },
        scope: { kind: "workspace", workspaceId: UUID },
        arguments: [],
      },
      cwd: "C:\\repo",
      protectedEnv: [],
      cols: 80,
      rows: 24,
    });
    await expect(adapter.inspectChildren(UUID, "8")).rejects.toThrow(/generation/i);
  });
});
