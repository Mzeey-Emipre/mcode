import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import type { PtyHostEvent } from "./pty-host-protocol.js";
import { spawnPtyHostChild } from "./pty-host-child.js";
import { PtyHostSupervisor, type PtyHostChild } from "./pty-host-supervisor.js";

const SESSION_ID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const OUTPUT_MARKER = "__MCODE_ISOLATED_HOST_OK__";
const SECOND_SESSION_ID = "12345678-abcd-4abc-8abc-abcdefabcdef";
const nativeRequire = createRequire(import.meta.url);

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

describe.runIf(process.platform === "win32")(
  "isolated PTY host supervisor",
  () => {
    it("runs a real ConPTY through a separate versioned Node host", async () => {
      const repoRoot = resolve(process.cwd(), "../..");
      const devDir = join(repoRoot, ".dev");
      mkdirSync(devDir, { recursive: true });
      const tempDir = mkdtempSync(join(devDir, "pty-host-test-"));
      const entryPath = join(tempDir, "pty-host.cjs");
      let supervisor: PtyHostSupervisor | null = null;
      try {
        await build({
          entryPoints: [
            resolve(process.cwd(), "src/terminal/host/pty-host-entry.ts"),
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
          platform: "windows",
          startupTimeoutMs: 20_000,
          heartbeatDegradedMs: 5_000,
          heartbeatUnhealthyMs: 10_000,
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
        const create = supervisor.create({
          sessionId: SESSION_ID,
          hostGeneration: "1",
          launch: {
            requestedProfileId: "automatic",
            resolvedProfile: {
              id: "certified:windows-powershell-7",
              name: "Command Prompt",
              executable: process.env.ComSpec ?? "cmd.exe",
              arguments: ["/Q"],
              source: "certified",
              platform: "windows",
            },
            scope: { kind: "workspace", workspaceId: SESSION_ID },
            arguments: ["/Q"],
          },
          cwd: process.cwd(),
          protectedEnv: env,
          cols: 80,
          rows: 24,
        });
        await expect(
          create.catch((error: unknown) => {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} ${diagnostics.join("")}`,
            );
          }),
        ).resolves.toMatchObject({
          state: "running",
          containment: "job-object",
        });

        await supervisor.send({
          sessionId: SESSION_ID,
          hostGeneration: "1",
          attachmentEpoch: "1",
          commandSeq: "1",
          kind: "input",
          data: Buffer.from(`echo ${OUTPUT_MARKER}\r`),
        });
        await waitForEvent(
          events,
          (event) =>
            event.kind === "output" &&
            Buffer.from(event.dataBase64, "base64")
              .toString("utf8")
              .includes(OUTPUT_MARKER),
        );
        await expect(
          supervisor.inspectChildren(SESSION_ID, "1"),
        ).resolves.toEqual({ hasChildren: false });
        await supervisor.close({
          sessionId: SESSION_ID,
          hostGeneration: "1",
          closeSeq: "2",
          reason: "user",
        });
        await expect(
          waitForEvent(events, (event) => event.kind === "exit"),
        ).resolves.toMatchObject({
          kind: "exit",
          reason: "user-close",
        });

        await supervisor.create({
          sessionId: SECOND_SESSION_ID,
          hostGeneration: "1",
          launch: {
            requestedProfileId: "automatic",
            resolvedProfile: {
              id: "certified:windows-powershell-7",
              name: "Command Prompt",
              executable: process.env.ComSpec ?? "cmd.exe",
              arguments: ["/Q"],
              source: "certified",
              platform: "windows",
            },
            scope: { kind: "workspace", workspaceId: SESSION_ID },
            arguments: ["/Q"],
          },
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
        children[0]!.kill("SIGKILL");
        const recoveryDeadline = Date.now() + 20_000;
        while (
          Date.now() < recoveryDeadline &&
          (supervisor.health().hostGeneration !== "2" ||
            supervisor.health().state !== "healthy")
        ) {
          await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
        }
        expect(supervisor.health()).toEqual({
          hostGeneration: "2",
          state: "healthy",
        });
        expect(children).toHaveLength(2);
        expect(() => process.kill(running.rootPid, 0)).toThrow();
      } finally {
        await supervisor?.shutdown();
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
