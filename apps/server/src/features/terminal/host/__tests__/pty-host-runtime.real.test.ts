import { describe, expect, it } from "vitest";
import type { PtyHostEvent } from "../pty-host-protocol.js";
import { PtyHostProcessRuntime } from "../pty-host-runtime.js";

const SESSION_ID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const OUTPUT_MARKER = "__MCODE_PTY_HOST_OK__";

function waitForEvent(
  events: readonly PtyHostEvent[],
  predicate: (event: PtyHostEvent) => boolean,
  timeoutMs = 10_000,
): Promise<PtyHostEvent> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const event = events.find(predicate);
      if (event) {
        resolve(event);
        return;
      }
      if (Date.now() >= deadline) {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for PTY host event`,
          ),
        );
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe.runIf(process.platform === "win32")("real PTY host", () => {
  it("creates, writes, reads, resizes, and closes a contained ConPTY", async () => {
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: `test-${process.arch}-${process.versions.modules}`,
      publish: (event) => events.push(event),
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "1",
      platform: "windows",
    });
    const envNames = [
      "PATH",
      "Path",
      "SystemRoot",
      "ComSpec",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "PATHEXT",
    ];
    const env = envNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [{ name, value }];
    });

    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "1",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: process.env.ComSpec ?? "cmd.exe",
      arguments: ["/Q"],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "containment",
        established: true,
        mechanism: "job-object",
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: "running" }));

    await runtime.receive({
      contractVersion: 1,
      kind: "command.input",
      sessionId: SESSION_ID,
      hostGeneration: "1",
      attachmentEpoch: "1",
      commandSeq: "1",
      dataBase64: Buffer.from(`echo ${OUTPUT_MARKER}\r`).toString("base64"),
    });
    await waitForEvent(
      events,
      (event) =>
        event.kind === "output" &&
        Buffer.from(event.dataBase64, "base64")
          .toString("utf8")
          .includes(OUTPUT_MARKER),
    );

    await runtime.receive({
      contractVersion: 1,
      kind: "command.resize",
      sessionId: SESSION_ID,
      hostGeneration: "1",
      attachmentEpoch: "1",
      commandSeq: "2",
      cols: 100,
      rows: 30,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "commandAck",
        appliedCommandSeq: "2",
      }),
    );

    const closing = runtime.receive({
      contractVersion: 1,
      kind: "close",
      sessionId: SESSION_ID,
      hostGeneration: "1",
      closeSeq: "3",
      reason: "user",
    });
    await closing;
    await expect(
      waitForEvent(events, (event) => event.kind === "exit"),
    ).resolves.toMatchObject({
      kind: "exit",
      reason: "user-close",
    });
    await runtime.dispose();
  }, 20_000);
});
