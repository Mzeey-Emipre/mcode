import type { ChildProcess } from "node:child_process";
import { logger } from "@mcode/shared";
import { getCatalogEntry, type Settings } from "@mcode/contracts";
import type { ProviderHostPorts } from "../../../host-ports.js";
import { AcpSessionRuntime } from "../../protocols/acp/acp-session-runtime.js";
import { buildCursorAcpArgs } from "../acp/cursor-acp-spawn-args.js";
import { cursorAcpProcessIdentity } from "../acp/cursor-acp-process-identity.js";
import { cursorSupportsHttpMcp } from "../acp/cursor-acp-capabilities.js";
import { createCursorTodoSnapshot } from "../events/cursor-todo-snapshot.js";
import type { CursorAcpClientBridge } from "../acp/cursor-acp-client-bridge.js";
import type { CursorBrowserContext, CursorSessionState } from "../cursor-session-state.js";

const STDERR_TAIL_MAX = 48;

/** Supplies provider-owned state changes around the ACP subprocess lifecycle. */
export interface CursorAcpProcessSpawnerDeps {
  host: ProviderHostPorts;
  getEnvironment: () => Record<string, string>;
  getSettings: () => Settings;
  getBrowserContext: (sessionId: string) => CursorBrowserContext | undefined;
  registerOpening: (sessionId: string, runtime: AcpSessionRuntime) => void;
  clearOpening: (sessionId: string) => void;
  onChildExit: (sessionId: string, child: ChildProcess) => void;
  bridge: CursorAcpClientBridge;
}

/** Starts and initializes Cursor ACP subprocesses without managing the session pool. */
export class CursorAcpProcessSpawner {
  constructor(private readonly deps: CursorAcpProcessSpawnerDeps) {}

  /** Probes candidate Cursor CLIs until one opens an initialized ACP session. */
  async spawn(
    sessionId: string,
    threadId: string,
    cwd: string,
    permissionMode: "full" | "default",
    settings: Settings,
  ): Promise<CursorSessionState> {
    let lastError: unknown = null;
    const processIdentity = cursorAcpProcessIdentity(settings, permissionMode);
    for (const cliPath of cursorCliProbeBinaries(settings)) {
      try {
        return await this.spawnOneCli(cliPath, sessionId, threadId, cwd, permissionMode, processIdentity);
      } catch (error) {
        this.deps.clearOpening(sessionId);
        lastError = error;
        if (/Failed to spawn cursor-agent/i.test(messageOf(error))) continue;
        break;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "Failed to spawn cursor-agent (acp)"));
  }

  /** Starts and initializes one named Cursor CLI candidate. */
  async spawnOneCli(
    cliPath: string,
    mcodeSessionId: string,
    threadId: string,
    cwd: string,
    permissionMode: "full" | "default",
    processIdentity: string,
  ): Promise<CursorSessionState> {
    let entry: CursorSessionState | undefined;
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: {
        command: cliPath,
        args: buildCursorAcpArgs({ permissionMode }),
        cwd,
        env: this.deps.getEnvironment(),
      },
      callbacks: {
        onPermissionRequest: async (request) => entry
          ? this.deps.bridge.requestPermission(entry, request)
          : { outcome: { outcome: "cancelled" } },
        onSessionUpdate: async (update) => {
          if (entry) await this.deps.bridge.deliverSessionUpdate(entry, update);
        },
        readTextFile: async (filePath) => entry
          ? this.deps.bridge.readWorkspaceFile(entry.cwd, filePath)
          : "",
        writeTextFile: async (filePath, content) => {
          if (!entry) throw new Error("Cursor ACP session is not ready");
          this.deps.bridge.writeWorkspaceFile(entry.cwd, filePath, content);
        },
        onExtensionRequest: async () => ({}),
        onExtensionNotification: async () => {},
      },
      clientFactory: (callbacks) => ({
        requestPermission: async (request) => entry
          ? this.deps.bridge.requestPermission(entry, request)
          : { outcome: { outcome: "cancelled" } },
        sessionUpdate: callbacks.onSessionUpdate,
        readTextFile: async ({ path: filePath }) => ({
          content: entry ? this.deps.bridge.readWorkspaceFile(entry.cwd, filePath) : "",
        }),
        writeTextFile: async ({ path: filePath, content }) => {
          if (!entry) throw new Error("Cursor ACP session is not ready");
          this.deps.bridge.writeWorkspaceFile(entry.cwd, filePath, content);
          return {};
        },
        extMethod: async (method, params) => entry
          ? (await this.deps.bridge.createClient(entry).extMethod?.(method, params)) ?? {}
          : {},
        extNotification: async (method, params) => {
          if (entry) await this.deps.bridge.createClient(entry).extNotification?.(method, params);
        },
      }),
      selectAuthMethod: (methods) => methods.find((method) => method.id === "cursor_login")?.id ?? methods[0]?.id,
      ignoreAuthenticationErrors: true,
      recoveryFailurePolicy: "fail-without-replacement",
      recoveryInactivityTimeoutMs: 20_000,
      onSessionOperation: ({ operation, sessionId }) => {
        if (!this.deps.getSettings().provider.cursor.traceSessionUpdates) return;
        logger.info("Cursor ACP session operation", {
          operation,
          threadId,
          logicalSessionId: sessionId,
        });
      },
      processes: this.deps.host.processes,
    });
    this.deps.registerOpening(mcodeSessionId, runtime);
    const browserContext = this.deps.getBrowserContext(mcodeSessionId);
    const child = runtime.state.child;
    const initializedEntry: CursorSessionState = {
      workspaceId: browserContext?.workspaceId ?? "unknown-workspace",
      browserPermissionCapability: browserContext?.browserPermissionCapability ?? "interact",
      browserHttpMcpSupported: false,
      mcodeSessionId,
      threadId,
      child,
      connection: runtime.state.connection,
      acpRuntime: runtime,
      acpSessionId: "",
      processIdentity,
      cwd,
      permissionMode,
      lastUsedAt: Date.now(),
      todoSnapshot: createCursorTodoSnapshot(),
      turnChain: Promise.resolve(),
      activeTurnState: null,
      replayTurnState: null,
      stickyHeavyInstructionsSent: false,
      cursorPromptOrdinal: 0,
      stderrTailLines: [],
      cursorModelAppliedPair: null,
      pendingUserStopAbort: false,
      supportsHttpMcp: false,
      threadControlMcpEnabled: true,
      mcodeRuntimeInstructions: "",
      mcodeRuntimeInstructionsSent: false,
      mcodeLogicalSessionReloaded: false,
    };
    entry = initializedEntry;
    child.stderr?.on("data", (chunk: Buffer) => {
      const verboseLogs = this.deps.getSettings().provider.cursor.verboseFailureLogs;
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (verboseLogs) logger.debug("cursor-agent acp stderr", { threadId, line: trimmed });
        initializedEntry.stderrTailLines.push(trimmed.slice(0, 2000));
        while (initializedEntry.stderrTailLines.length > STDERR_TAIL_MAX) {
          initializedEntry.stderrTailLines.shift();
        }
      }
    });
    child.on("exit", () => this.deps.onChildExit(mcodeSessionId, child));
    const initialized = await runtime.initialize() as {
      agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
    };
    const supportsHttpMcp = cursorSupportsHttpMcp(initialized);
    initializedEntry.browserHttpMcpSupported = supportsHttpMcp;
    initializedEntry.supportsHttpMcp = supportsHttpMcp;
    return initializedEntry;
  }
}

function cursorCliProbeBinaries(settings: Settings): string[] {
  const configured = settings.provider.cli.cursor?.trim();
  return configured ? [configured] : [getCatalogEntry("cursor").cliBinary, "agent"];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
