import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { TerminalPlatform } from "@mcode/contracts";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { InMemoryPtyHostCleanupLedger } from "../../testing/in-memory-pty-host-cleanup-ledger.js";
import { spawnPtyHostChild } from "../../host/pty-host-child.js";
import type { PtyHostEvent } from "../../host/pty-host-protocol.js";
import { PtyHostSupervisor, type PtyHostChild } from "../../host/pty-host-supervisor.js";
import { ModernTerminalSessionRuntime } from "../terminal-session-runtime.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000002";
const SECOND_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000003";
const TEST_PLATFORM: TerminalPlatform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
const nativeRequire = NodeModule.createRequire(import.meta.url);
const desktopRequire = NodeModule.createRequire(
  NodePath.resolve(process.cwd(), "../desktop/package.json"),
);

function resolveElectronExecutable(): string {
  const executable = desktopRequire("electron") as string;
  if (!NodeFS.existsSync(executable)) {
    throw new Error("Electron executable is required for the isolated PTY host");
  }
  return executable;
}

function launchSnapshot() {
  const executable = TEST_PLATFORM === "windows" ? process.env.ComSpec ?? "cmd.exe" : "/bin/bash";
  const arguments_ = TEST_PLATFORM === "windows" ? ["/Q"] : ["--noprofile", "--norc"];
  return {
    requestedProfileId: "automatic" as const,
    resolvedProfile: {
      id: TEST_PLATFORM === "windows"
        ? "certified:windows-cmd" as const
        : `certified:${TEST_PLATFORM}-bash` as const,
      name: TEST_PLATFORM === "windows" ? "Command Prompt" : "Bash",
      executable,
      arguments: arguments_,
      source: "certified" as const,
      platform: TEST_PLATFORM,
    },
    scope: { kind: "workspace" as const, workspaceId: SESSION_ID },
    arguments: arguments_,
  };
}

function protectedEnvironment(): Array<{ name: string; value: string }> {
  return [
    "PATH",
    "Path",
    "HOME",
    "LANG",
    "SHELL",
    "SystemRoot",
    "ComSpec",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [{ name, value }];
  });
}

async function waitForOutput(
  runtime: ModernTerminalSessionRuntime,
  diagnostics: readonly string[],
  hostEvents: readonly PtyHostEvent[],
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const sequence = runtime.getSnapshot(SESSION_ID)?.lastOutputSeq;
    if (sequence && BigInt(sequence) > 0n) return sequence;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(
    `Timed out after 10000ms waiting for runtime output; snapshot=${JSON.stringify(runtime.getSnapshot(SESSION_ID))}; hostEvents=${JSON.stringify(hostEvents)}; diagnostics=${JSON.stringify(diagnostics)}`,
  );
}

async function waitForOutputAfter(
  runtime: ModernTerminalSessionRuntime,
  previousOutputSeq: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  let latestSequence: string | null = null;
  let quietSince = 0;
  while (Date.now() < deadline) {
    const sequence = runtime.getSnapshot(SESSION_ID)?.lastOutputSeq;
    if (sequence && BigInt(sequence) > BigInt(previousOutputSeq)) {
      if (sequence !== latestSequence) {
        latestSequence = sequence;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= 200) {
        return sequence;
      }
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(`Timed out after 10000ms waiting for output after ${previousOutputSeq}`);
}

async function waitForOutputToSettle(runtime: ModernTerminalSessionRuntime): Promise<string> {
  const sequence = runtime.getSnapshot(SESSION_ID)?.lastOutputSeq ?? "0";
  const deadline = Date.now() + 10_000;
  let latestSequence = sequence;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const nextSequence = runtime.getSnapshot(SESSION_ID)?.lastOutputSeq ?? "0";
    if (nextSequence !== latestSequence) {
      latestSequence = nextSequence;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= 200) {
      return nextSequence;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error("Timed out after 10000ms waiting for output to settle");
}

async function waitForCommand(
  runtime: ModernTerminalSessionRuntime,
  commandSeq: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (runtime.getSnapshot(SESSION_ID)?.lastCommandSeq === commandSeq) return;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(`Timed out after 10000ms waiting for command ${commandSeq}`);
}

describe.runIf(["win32", "darwin", "linux"].includes(process.platform))(
  "ModernTerminalSessionRuntime with the supervised PTY host",
  () => {
    it("restores bounded output after a real shell detaches, then closes its process tree", async () => {
      const repoRoot = NodePath.resolve(process.cwd(), "../..");
      const devDir = NodePath.join(repoRoot, ".dev");
      NodeFS.mkdirSync(devDir, { recursive: true });
      const tempDir = NodeFS.mkdtempSync(NodePath.join(devDir, "terminal-runtime-live-"));
      const entryPath = NodePath.join(tempDir, "pty-host.cjs");
      let supervisor: PtyHostSupervisor | null = null;
      let runtime: ModernTerminalSessionRuntime | null = null;
      try {
        await build({
          entryPoints: [NodePath.resolve(process.cwd(), "src/features/terminal/host/pty-host-entry.ts")],
          outfile: entryPath,
          bundle: true,
          platform: "node",
          target: "node22",
          format: "cjs",
          external: ["node-pty", "koffi"],
          banner: {
            js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;',
          },
          define: { "import.meta.url": "__importMetaUrl" },
        });
        const diagnostics: string[] = [];
        const hostEvents: PtyHostEvent[] = [];
        const children: PtyHostChild[] = [];
        supervisor = new PtyHostSupervisor({
          platform: TEST_PLATFORM,
          cleanupLedger: new InMemoryPtyHostCleanupLedger(),
          startupTimeoutMs: 20_000,
          heartbeatDegradedMs: 5_000,
          heartbeatUnhealthyMs: 10_000,
          operationTimeoutMs: 20_000,
          spawnHost: () => {
            const child = spawnPtyHostChild({
              platform: process.platform,
              architecture: process.arch,
              entryPath,
              executablePath: resolveElectronExecutable(),
              env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: "1",
                NODE_PATH: [
                  NodePath.dirname(NodePath.dirname(nativeRequire.resolve("node-pty/package.json"))),
                  NodePath.dirname(NodePath.dirname(nativeRequire.resolve("koffi/package.json"))),
                  process.env.NODE_PATH,
                ]
                  .filter((value): value is string => Boolean(value))
                  .join(NodePath.delimiter),
              },
              onStderr: (text) => diagnostics.push(text),
            });
            children.push(child);
            return child;
          },
        });
        const health = await supervisor.start();
        supervisor.subscribe((event) => hostEvents.push(event));
        runtime = new ModernTerminalSessionRuntime({
          host: supervisor,
        });
        const launch = launchSnapshot();
        await runtime.createSession({
          sessionId: SESSION_ID,
          scope: launch.scope,
          launch,
          hostGeneration: health.hostGeneration,
          cwd: process.cwd(),
          protectedEnv: protectedEnvironment(),
        });
        const attachment = await runtime.attach({
          sessionId: SESSION_ID,
          attachmentId: ATTACHMENT_ID,
          hostGeneration: health.hostGeneration,
          lastOutputSeq: "0",
          lastCommandSeq: "0",
          checkpointSeq: null,
        });
        const initialHydration = runtime.consumeHydration({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: attachment.attachmentEpoch,
          hydrationId: attachment.hydrationId,
        });
        runtime.acknowledgeOutput({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: attachment.attachmentEpoch,
          outputSeq:
            initialHydration.descriptor.lastOutputSeq ??
            initialHydration.descriptor.checkpointThroughSeq ??
            initialHydration.descriptor.requestedAfterSeq,
        });
        await runtime.sendCommand({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: attachment.attachmentEpoch,
          commandSeq: "1",
          kind: "resize",
          data: { cols: 100, rows: 30 },
        });
        await runtime.sendCommand({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: attachment.attachmentEpoch,
          commandSeq: "2",
          kind: "input",
          data: Buffer.from("echo runtime-live\r"),
        });
        await waitForOutput(runtime, diagnostics, hostEvents);
        await expect(runtime.sendCommand({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: "2",
          commandSeq: "3",
          kind: "input",
          data: Buffer.from("echo stale\r"),
        })).rejects.toMatchObject({ code: "STALE_ATTACHMENT" });
        await waitForCommand(runtime, "2");
        const replayBaseSeq = await waitForOutputToSettle(runtime);
        await runtime.sendCommand({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: attachment.attachmentEpoch,
          commandSeq: "3",
          kind: "input",
          data: Buffer.from("echo runtime-replay\r"),
        });
        await waitForCommand(runtime, "3");
        await runtime.detach({
          sessionId: SESSION_ID,
          attachmentId: ATTACHMENT_ID,
          attachmentEpoch: attachment.attachmentEpoch,
          reason: "disconnect",
        });
        await waitForOutputAfter(runtime, replayBaseSeq);
        const recoveredAttachment = await runtime.attach({
          sessionId: SESSION_ID,
          attachmentId: SECOND_ATTACHMENT_ID,
          hostGeneration: health.hostGeneration,
          lastOutputSeq: replayBaseSeq,
          lastCommandSeq: "3",
          checkpointSeq: null,
        });
        const recoveredHydration = runtime.consumeHydration({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: recoveredAttachment.attachmentEpoch,
          hydrationId: recoveredAttachment.hydrationId,
        });
        expect(recoveredHydration.descriptor).toMatchObject({
          mode: "delta",
          requestedAfterSeq: replayBaseSeq,
          gap: null,
        });
        expect(
          Buffer.concat(recoveredHydration.output.map((chunk) => Buffer.from(chunk.data))).toString(),
        ).toContain("runtime-replay");
        runtime.acknowledgeOutput({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: recoveredAttachment.attachmentEpoch,
          outputSeq:
            recoveredHydration.descriptor.lastOutputSeq ??
            recoveredHydration.descriptor.checkpointThroughSeq ??
            recoveredHydration.descriptor.requestedAfterSeq,
        });
        await runtime.sendCommand({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: recoveredAttachment.attachmentEpoch,
          commandSeq: "4",
          kind: "resize",
          data: { cols: 90, rows: 25 },
        });
        await waitForCommand(runtime, "4");

        await expect(runtime.close({ sessionId: SESSION_ID, reason: "user" })).resolves.toMatchObject({
          state: "exited",
          tombstone: true,
          exit: { reason: "user-close" },
        });
        expect(children).toHaveLength(1);
        expect(diagnostics.join("")).not.toMatch(/protocol|containment failed/i);
      } finally {
        if (runtime) await runtime.shutdown().catch(() => undefined);
        else if (supervisor) await supervisor.shutdown().catch(() => undefined);
        if (NodeFS.existsSync(tempDir)) NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 40_000);
  },
);
