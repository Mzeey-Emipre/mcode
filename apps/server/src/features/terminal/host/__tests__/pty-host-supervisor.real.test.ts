import type { TerminalPlatform } from "@mcode/contracts";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  evaluateTerminalWorkload,
  listTerminalWorkloads,
  TERMINAL_WORKLOAD_LIMITS,
  type TerminalResizeObservation,
} from "../../testing/terminal-workload-corpus.js";
import { InMemoryPtyHostCleanupLedger } from "../../testing/in-memory-pty-host-cleanup-ledger.js";
import type { PtyHostCreate } from "../pty-host-adapter.js";
import { spawnPtyHostChild } from "../pty-host-child.js";
import type { PtyHostEvent } from "../pty-host-protocol.js";
import { PtyHostSupervisor, type PtyHostChild } from "../pty-host-supervisor.js";

const SECOND_SESSION_ID = "12345678-abcd-4abc-8abc-abcdefabcdef";
const nativeRequire = createRequire(import.meta.url);
const TEST_PLATFORM: TerminalPlatform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
const IS_POSIX = TEST_PLATFORM !== "windows";

function createShellLaunchRequest(sessionId: string): PtyHostCreate["launch"] {
  const executable =
    TEST_PLATFORM === "windows" ? process.env.ComSpec ?? "cmd.exe" : "/bin/bash";
  const arguments_ =
    TEST_PLATFORM === "windows" ? ["/Q"] : ["--noprofile", "--norc"];
  return {
    requestedProfileId: "automatic",
    resolvedProfile: {
      id:
        TEST_PLATFORM === "windows"
          ? "certified:windows-cmd"
          : `certified:${TEST_PLATFORM}-bash`,
      name: TEST_PLATFORM === "windows" ? "Command Prompt" : "Bash",
      executable,
      arguments: arguments_,
      source: "certified",
      platform: TEST_PLATFORM,
    },
    scope: { kind: "workspace", workspaceId: sessionId },
    arguments: arguments_,
  };
}

function resolveNodeExecutable(): string {
  if (/[\\/]node(?:\.exe)?$/i.test(process.execPath)) return process.execPath;
  const pathValue =
    TEST_PLATFORM === "windows"
      ? execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
          ],
          { encoding: "utf8", timeout: 5_000 },
        ).trim()
      : execFileSync(process.env.SHELL ?? "/bin/sh", ["-ilc", "printf %s \"$PATH\""], {
          encoding: "utf8",
          timeout: 5_000,
        }).trim();
  if (pathValue) {
    const executableName = TEST_PLATFORM === "windows" ? "node.exe" : "node";
    for (const directory of pathValue.split(delimiter)) {
      const candidate = join(directory, executableName);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Node.js is required for the PTY workload corpus");
}

function workloadCommand(scriptPath: string, nodeExecutable: string): Buffer {
  const quote = (value: string): string =>
    TEST_PLATFORM === "windows"
      ? `"${value.replace(/"/g, '""')}"`
      : `'${value.replace(/'/g, `'"'"'`)}'`;
  if (TEST_PLATFORM === "windows") {
    const wrapperPath = `${scriptPath}.cmd`;
    writeFileSync(
      wrapperPath,
      `@echo off\r\n${quote(nodeExecutable)} ${quote(scriptPath)}\r\necho WF:runner-exit:%errorlevel%\r\n`,
      "utf8",
    );
    return Buffer.from(`${quote(wrapperPath)}\r`);
  }
  return Buffer.from(
    `${quote(nodeExecutable)} ${quote(scriptPath)}; printf 'WF:%s:%s\\n' runner-exit $?\r`,
  );
}

function corpusSessionId(index: number): string {
  return `0000000${String(index + 1)}-0000-4000-8000-000000000000`;
}

function outputText(
  events: readonly PtyHostEvent[],
  sessionId: string,
): string {
  return events
    .flatMap((event) =>
      event.kind === "output" && event.sessionId === sessionId
        ? [Buffer.from(event.dataBase64, "base64").toString("utf8")]
        : [],
    )
    .join("");
}

async function waitForOutput(
  events: readonly PtyHostEvent[],
  sessionId: string,
  predicate: (output: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = outputText(events, sessionId);
    if (predicate(output)) return output;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for PTY host output`);
}

async function waitForEvent(
  events: readonly PtyHostEvent[],
  predicate: (event: PtyHostEvent) => boolean,
  timeoutMs = 30_000,
): Promise<PtyHostEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for isolated PTY host event`,
  );
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(`Process ${pid} survived for ${timeoutMs}ms after PTY close`);
}

async function waitForChildInspection(
  supervisor: PtyHostSupervisor,
  sessionId: string,
  hostGeneration: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      (await supervisor.inspectChildren(sessionId, hostGeneration)).hasChildren
    ) {
      return;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(`PTY child was not visible after ${timeoutMs}ms`);
}

describe.runIf(["win32", "darwin", "linux"].includes(process.platform))(
  "isolated PTY host supervisor",
  () => {
    it("runs a real contained PTY through a separate versioned Node host", async () => {
      const repoRoot = resolve(process.cwd(), "../..");
      const devDir = join(repoRoot, ".dev");
      mkdirSync(devDir, { recursive: true });
      const tempDir = mkdtempSync(join(devDir, "pty-host-test-"));
      const entryPath = join(tempDir, "pty-host.cjs");
      let supervisor: PtyHostSupervisor | null = null;
      try {
        await build({
          entryPoints: [
            resolve(process.cwd(), "src/features/terminal/host/pty-host-entry.ts"),
          ],
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
        const events: PtyHostEvent[] = [];
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
                  dirname(
                    dirname(nativeRequire.resolve("node-pty/package.json")),
                  ),
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
        supervisor.subscribe((event) => events.push(event));
        await expect(supervisor.start()).resolves.toMatchObject({
          state: "healthy",
        });

        async function runAllWorkloads(): Promise<void> {
        const nodeExecutable = resolveNodeExecutable();
        const envNames = [
          "PATH",
          "Path",
          "HOME",
          "LANG",
          "LC_ALL",
          "SHELL",
          "TERM",
          "TMPDIR",
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

        async function runCorpusWorkloads(): Promise<void> {
        async function runCorpusWorkload(
          index: number,
          workload: ReturnType<typeof listTerminalWorkloads>[number],
        ): Promise<void> {
          const sessionId = corpusSessionId(index);
          const scriptPath = join(tempDir, `${workload.id}.cjs`);
          writeFileSync(scriptPath, workload.program.source, "utf8");
          const running = await supervisor.create({
            sessionId,
            hostGeneration: "1",
            launch: createShellLaunchRequest(sessionId),
            cwd: process.cwd(),
            protectedEnv: env,
            cols: workload.initialDimensions.cols,
            rows: workload.initialDimensions.rows,
          });
          expect(running).toMatchObject({
            state: "running",
            containment: IS_POSIX ? "process-group" : "job-object",
          });
          await waitForOutput(
            events,
            sessionId,
            (value) =>
              TEST_PLATFORM === "windows" ? value.includes(">") : value.length > 0,
            10_000,
          );
          async function executeWorkload(): Promise<{
            commandSeq: number;
            detachedOutputBytes: number;
            resizeTrace: TerminalResizeObservation[];
            startedAt: number;
          }> {
          const startedAt = Date.now();
          const resizeTrace: TerminalResizeObservation[] = [
            {
              kind: "initial",
              cols: workload.initialDimensions.cols,
              rows: workload.initialDimensions.rows,
              elapsedMs: 0,
            },
          ];
          await supervisor.send({
            sessionId,
            hostGeneration: "1",
            attachmentEpoch: "1",
            commandSeq: "1",
            kind: "input",
            data: workloadCommand(scriptPath, nodeExecutable),
          });
          await waitForEvent(
            events,
            (event) =>
              event.kind === "commandAck" &&
              event.sessionId === sessionId &&
              event.appliedCommandSeq === "1",
            TERMINAL_WORKLOAD_LIMITS.maxDurationMs,
          );
          await waitForOutput(
            events,
            sessionId,
            (value) => value.includes(workload.synchronizationMarker),
            TERMINAL_WORKLOAD_LIMITS.maxDurationMs,
          ).catch((error: unknown) => {
            throw new Error(
              `${workload.id}: ${error instanceof Error ? error.message : String(error)}; output=${JSON.stringify(outputText(events, sessionId))}; diagnostics=${diagnostics.join("")}`,
            );
          });

          let commandSeq = 1;
          let disconnectedAtBytes: number | null = null;
          let detachedOutputBytes = 0;
          for (const step of workload.steps) {
            if (step.kind === "wait") {
              await new Promise((resolveWait) =>
                setTimeout(resolveWait, step.durationMs),
              );
              continue;
            }
            if (step.kind === "disconnect") {
              disconnectedAtBytes = Buffer.byteLength(
                outputText(events, sessionId),
                "utf8",
              );
              continue;
            }
            if (step.kind === "reconnect") {
              if (disconnectedAtBytes !== null) {
                detachedOutputBytes =
                  Buffer.byteLength(outputText(events, sessionId), "utf8") -
                  disconnectedAtBytes;
              }
              continue;
            }
            commandSeq += 1;
            const sequence = String(commandSeq);
            await supervisor.send(
              step.kind === "write"
                ? {
                    sessionId,
                    hostGeneration: "1",
                    attachmentEpoch: "1",
                    commandSeq: sequence,
                    kind: "input",
                    data: Buffer.from(
                      process.platform === "win32"
                        ? step.data.replace(/\n/g, "\r")
                        : step.data,
                    ),
                  }
                : {
                    sessionId,
                    hostGeneration: "1",
                    attachmentEpoch: "1",
                    commandSeq: sequence,
                    kind: "resize",
                    data: step.dimensions,
                  },
            );
            await waitForEvent(
              events,
              (event) =>
                event.kind === "commandAck" &&
                event.sessionId === sessionId &&
                event.appliedCommandSeq === sequence,
              TERMINAL_WORKLOAD_LIMITS.maxDurationMs,
            );
            if (step.kind === "resize") {
              resizeTrace.push({
                kind: "resize",
                cols: step.dimensions.cols,
                rows: step.dimensions.rows,
                elapsedMs: Date.now() - startedAt,
              });
            }
          }

          async function sendCompletionInput(): Promise<void> {
            const input = workload.completion.input;
            if (!input) return;
            commandSeq += 1;
            await supervisor.send({
              sessionId,
              hostGeneration: "1",
              attachmentEpoch: "1",
              commandSeq: String(commandSeq),
              kind: "input",
              data: Buffer.from(process.platform === "win32" ? input.replace(/\n/g, "\r") : input),
            });
          }

          await sendCompletionInput();

          await waitForOutput(
            events,
            sessionId,
            (value) =>
              workload.expectedMarkers.every((marker) =>
                value.includes(marker),
              ) &&
              (workload.completion.terminateAfter ||
                /WF:runner-exit:\s*-?\d+\r?(?:\n|$)/.test(value)),
            workload.completion.waitMs,
          ).catch((error: unknown) => {
            throw new Error(
              `${workload.id}: ${error instanceof Error ? error.message : String(error)}; missing=${workload.expectedMarkers.filter((marker) => !outputText(events, sessionId).includes(marker)).join(",")}; output=${JSON.stringify(outputText(events, sessionId))}`,
            );
          });

          return { commandSeq, detachedOutputBytes, resizeTrace, startedAt };
          }

          let { commandSeq, detachedOutputBytes, resizeTrace, startedAt } = await executeWorkload();

          let descendantPid: number | null = null;
          if (workload.completion.terminateAfter) {
            await waitForChildInspection(supervisor, sessionId, "1");
            const childPidMatch = /WF:cleanup:child:[^\d]{0,64}(\d+)/.exec(
              outputText(events, sessionId),
            );
            if (!childPidMatch) {
              throw new Error("Expected the corpus descendant PID marker");
            }
            descendantPid = Number(childPidMatch[1]);
          }
          const workloadDurationMs = Date.now() - startedAt;
          const cleanupStartedAt = Date.now();
          commandSeq += 1;
          await supervisor.close({
            sessionId,
            hostGeneration: "1",
            closeSeq: String(commandSeq),
            reason: "user",
          });
          const exit = await waitForEvent(
            events,
            (event) => event.kind === "exit" && event.sessionId === sessionId,
            TERMINAL_WORKLOAD_LIMITS.maxDurationMs,
          );
          if (exit.kind !== "exit") throw new Error("Expected a PTY exit event");
          if (descendantPid !== null) {
            await waitForProcessExit(
              descendantPid,
              TERMINAL_WORKLOAD_LIMITS.maxProcessLifetimeMs,
            );
          }

          const output = outputText(events, sessionId);
          const runnerExitCode = workload.completion.terminateAfter
            ? exit.code
            : Number(/WF:runner-exit:[^\d-]*(-?\d+)/.exec(output)?.[1]);
          const result = evaluateTerminalWorkload(workload, {
            output,
            outputBytes: Buffer.byteLength(output, "utf8"),
            outputTruncated: false,
            detachedOutputBytes,
            resizeTrace,
            durationMs: workloadDurationMs,
            synchronizationObserved: true,
            exitObserved: true,
            exitCode: runnerExitCode,
            childPids: descendantPid === null ? [] : [descendantPid],
            childPidsAliveAfterKill: [],
            childPidsAliveAfterCleanup: [],
            cleanupDurationMs: Date.now() - cleanupStartedAt,
          });
          expect(result.failedChecks, workload.id).toEqual([]);
          expect(result.normalizedOutputSha256).toMatch(/^[a-f0-9]{64}$/);
        }
        for (const [index, workload] of listTerminalWorkloads().entries()) {
          await runCorpusWorkload(index, workload);
        }
        }

        await runCorpusWorkloads();

        async function verifyCrashRecovery(): Promise<void> {
        const cleanupWorkload = listTerminalWorkloads().find(
          (workload) => workload.id === "process-cleanup",
        );
        if (!cleanupWorkload) throw new Error("Process cleanup corpus is missing");
        const cleanupScriptPath = join(tempDir, "crash-process-cleanup.cjs");
        writeFileSync(cleanupScriptPath, cleanupWorkload.program.source, "utf8");
        await supervisor.create({
          sessionId: SECOND_SESSION_ID,
          hostGeneration: "1",
          launch: createShellLaunchRequest(SECOND_SESSION_ID),
          cwd: process.cwd(),
          protectedEnv: env,
          cols: 80,
          rows: 24,
        });
        const running = await waitForEvent(
          events,
          (event) =>
            event.kind === "running" && event.sessionId === SECOND_SESSION_ID,
        );
        if (running.kind !== "running")
          throw new Error("Expected a running PTY event");
        await waitForOutput(
          events,
          SECOND_SESSION_ID,
          (value) =>
            TEST_PLATFORM === "windows" ? value.includes(">") : value.length > 0,
          10_000,
        );
        await supervisor.send({
          sessionId: SECOND_SESSION_ID,
          hostGeneration: "1",
          attachmentEpoch: "1",
          commandSeq: "1",
          kind: "input",
          data: workloadCommand(cleanupScriptPath, nodeExecutable),
        });
        const crashOutput = await waitForOutput(
          events,
          SECOND_SESSION_ID,
          (value) => value.includes("WF:cleanup:child:"),
          TERMINAL_WORKLOAD_LIMITS.maxDurationMs,
        );
        const crashDescendantPid = Number(
          /WF:cleanup:child:[^\d]{0,64}(\d+)/.exec(crashOutput)?.[1],
        );
        if (!Number.isSafeInteger(crashDescendantPid)) {
          throw new Error("Expected the crash descendant PID marker");
        }
        children[0]!.kill("SIGKILL");
        const recoveryDeadline = Date.now() + 20_000;
        while (
          Date.now() < recoveryDeadline &&
          (supervisor.health().hostGeneration !== "2" ||
            supervisor.health().state !== "healthy")
        ) {
          await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
        }
        expect(supervisor.health(), diagnostics.join("\n")).toEqual({
          hostGeneration: "2",
          state: "healthy",
        });
        expect(children).toHaveLength(2);
        expect(() => process.kill(running.rootPid, 0)).toThrow();
        await waitForProcessExit(
          crashDescendantPid,
          TERMINAL_WORKLOAD_LIMITS.maxProcessLifetimeMs,
        );
        }

        await verifyCrashRecovery();
        }

        await runAllWorkloads();
      } finally {
        await supervisor?.shutdown();
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
