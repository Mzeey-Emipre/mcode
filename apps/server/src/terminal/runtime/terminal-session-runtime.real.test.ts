import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import type { TerminalPlatform } from "@mcode/contracts";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { InMemoryPtyHostCleanupLedger } from "../testing/in-memory-pty-host-cleanup-ledger.js";
import { spawnPtyHostChild } from "../host/pty-host-child.js";
import { PtyHostSupervisor, type PtyHostChild } from "../host/pty-host-supervisor.js";
import { ModernTerminalSessionRuntime } from "./terminal-session-runtime.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000002";
const SECOND_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000003";
const TEST_PLATFORM: TerminalPlatform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
const nativeRequire = createRequire(import.meta.url);

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

async function waitForOutput(runtime: ModernTerminalSessionRuntime): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const sequence = runtime.getSnapshot(SESSION_ID)?.lastOutputSeq;
    if (sequence && BigInt(sequence) > 0n) return sequence;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error("Timed out after 10000ms waiting for runtime output");
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
    it("creates, attaches, orders commands, rejects a stale lease, and closes a real shell", async () => {
      const repoRoot = resolve(process.cwd(), "../..");
      const devDir = join(repoRoot, ".dev");
      mkdirSync(devDir, { recursive: true });
      const tempDir = mkdtempSync(join(devDir, "terminal-runtime-live-"));
      const entryPath = join(tempDir, "pty-host.cjs");
      let supervisor: PtyHostSupervisor | null = null;
      let runtime: ModernTerminalSessionRuntime | null = null;
      try {
        await build({
          entryPoints: [resolve(process.cwd(), "src/terminal/host/pty-host-entry.ts")],
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
              entryPath,
              env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: "1",
                NODE_PATH: [
                  dirname(dirname(nativeRequire.resolve("node-pty/package.json"))),
                  dirname(dirname(nativeRequire.resolve("koffi/package.json"))),
                  process.env.NODE_PATH,
                ]
                  .filter((value): value is string => Boolean(value))
                  .join(delimiter),
              },
              onStderr: (text) => diagnostics.push(text),
            });
            children.push(child);
            return child;
          },
        });
        const health = await supervisor.start();
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
        const outputSeq = await waitForOutput(runtime);
        await expect(runtime.sendCommand({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: "2",
          commandSeq: "3",
          kind: "input",
          data: Buffer.from("echo stale\r"),
        })).rejects.toMatchObject({ code: "STALE_ATTACHMENT" });
        await waitForCommand(runtime, "2");
        const recoveredAttachment = await runtime.attach({
          sessionId: SESSION_ID,
          attachmentId: SECOND_ATTACHMENT_ID,
          hostGeneration: health.hostGeneration,
          lastOutputSeq: outputSeq,
          lastCommandSeq: "2",
          checkpointSeq: null,
        });
        await runtime.sendCommand({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: recoveredAttachment.attachmentEpoch,
          commandSeq: "3",
          kind: "resize",
          data: { cols: 90, rows: 25 },
        });
        await waitForCommand(runtime, "3");
        runtime.acknowledgeOutput({
          sessionId: SESSION_ID,
          hostGeneration: health.hostGeneration,
          attachmentEpoch: recoveredAttachment.attachmentEpoch,
          outputSeq,
        });

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
        if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
      }
    }, 40_000);
  },
);
