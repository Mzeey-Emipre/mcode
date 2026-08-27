import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { logger } from "@mcode/shared";
import type { ProviderHostPorts } from "../../../host-ports.js";
import { buildCursorAcpArgs } from "../acp/cursor-acp-spawn-args.js";
import { cursorSupportsHttpMcp } from "../acp/cursor-acp-capabilities.js";
import { createCursorAcpTurnState, mapCursorAcpSessionNotification } from "../acp/cursor-acp-event-mapper.js";
import { createCursorTodoSnapshot } from "../events/cursor-todo-snapshot.js";
import { resolveCursorAssistantMessageContent } from "../stream-json/cursor-stream-event-mapper.js";
import {
  validateAcpInitializeResult,
  validateAcpSessionUpdate,
} from "../../protocols/acp/acp-session-runtime.js";

/** Minimal transport needed to reconstruct and query a throwaway ACP session. */
export interface CursorSideChannelTransport {
  loadSession(args: { cwd: string; mcpServers: never[]; sessionId: string }): Promise<unknown>;
  prompt(args: { sessionId: string; prompt: { type: "text"; text: string }[] }): Promise<unknown>;
  dispose(): Promise<void> | void;
}

/** Opens a side-channel transport for a non-emitting ACP client. */
export type CursorSideChannelConnector = (args: {
  cwd: string;
  client: Client;
}) => Promise<CursorSideChannelTransport>;

/** Supplies side-channel dependencies that must remain owned by the provider host. */
export interface CursorSideChannelDeps {
  host: ProviderHostPorts;
  getEnvironment: () => Record<string, string>;
  getCliCandidates: () => string[];
  readWorkspaceFile: (cwd: string, filePath: string) => string;
}

/** Runs clean handoff queries without registering or mutating the parent session. */
export class CursorSideChannel {
  /** Allows tests to substitute a transport without launching Cursor. */
  connector: CursorSideChannelConnector = (args) => this.createTransport(args);

  constructor(private readonly deps: CursorSideChannelDeps) {}

  /** Reconstructs a saved session in an isolated process and returns its summary. */
  async run(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string> {
    const { parentThreadId, parentSdkSessionId, prompt, abortSignal, cwd } = args;
    void args.conversationHistory;
    if (!parentSdkSessionId) {
      throw transientHandoffError(
        `No persisted Cursor session for parent thread ${parentThreadId}; cannot run clean side-channel query`,
      );
    }
    if (abortSignal?.aborted) {
      throw transientHandoffError("Cursor side-channel query aborted before start");
    }

    const turnState = createCursorAcpTurnState();
    const todoSnapshot = createCursorTodoSnapshot();
    const sideChannelThreadId = `sidechannel-${randomUUID()}`;
    const client: Client = {
      // The throwaway summary process must never modify user state.
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async (params: SessionNotification) => {
        const update = validateAcpSessionUpdate(params);
        if (update.sessionId !== parentSdkSessionId) return;
        mapCursorAcpSessionNotification(update, sideChannelThreadId, turnState, todoSnapshot);
      },
      readTextFile: async (request) => ({
        content: this.deps.readWorkspaceFile(cwd, request.path),
      }),
      writeTextFile: async () => {
        throw new Error("Cursor side-channel is read-only");
      },
      extMethod: async () => ({}),
      extNotification: async () => {},
    };

    let transport: CursorSideChannelTransport;
    try {
      transport = await this.connector({ cwd, client });
    } catch (error) {
      throw transientHandoffError(
        `Failed to open Cursor side-channel connection: ${messageOf(error)}`,
      );
    }

    let disposal: Promise<void> | null = null;
    const disposeOnce = (): Promise<void> => {
      if (!disposal) disposal = Promise.resolve(transport.dispose());
      return disposal;
    };
    const onAbort = (): void => { void disposeOnce(); };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        await transport.loadSession({ cwd, mcpServers: [], sessionId: parentSdkSessionId });
      } catch (error) {
        throw transientHandoffError(
          `Cursor side-channel could not reconstruct parent session ${parentSdkSessionId}: ${messageOf(error)}`,
        );
      }
      await transport.prompt({
        sessionId: parentSdkSessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      const text = resolveCursorAssistantMessageContent(turnState.accumulator).trim();
      if (!text) throw transientHandoffError("Cursor side-channel query returned empty output");
      return text;
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
      await disposeOnce();
    }
  }

  /** Opens the default `cursor-agent acp` transport and owns its process-tree cleanup. */
  async createTransport(args: { cwd: string; client: Client }): Promise<CursorSideChannelTransport> {
    const child = this.spawnChild(args.cwd);
    if (!child.stdin || !child.stdout) {
      throw new Error("Failed to spawn cursor-agent: stdio pipes unavailable");
    }
    const out = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const connection = new ClientSideConnection(() => args.client, ndJsonStream(out, input));
    try {
      await this.acpHandshake(connection, "cursor-side-channel");
    } catch (error) {
      if (child.pid !== undefined) {
        await this.deps.host.processes.terminateTree(child.pid).catch(() => undefined);
      }
      throw error;
    }
    return {
      loadSession: (request) => connection.loadSession(request),
      prompt: (request) => connection.prompt(request),
      dispose: async () => {
        if (child.pid != null) {
          await this.deps.host.processes.terminateTree(child.pid).catch(() => undefined);
        }
      },
    };
  }

  /** Performs the ACP initialization handshake and best-effort authentication. */
  async acpHandshake(connection: ClientSideConnection, threadId: string): Promise<boolean> {
    const initialized = validateAcpInitializeResult(await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "mcode", title: "Mcode", version: "0.0.1" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }));
    const authMethods = initialized.authMethods ?? [];
    const methodId = authMethods.find((method) => method.id === "cursor_login")?.id ?? authMethods[0]?.id;
    if (methodId) {
      await connection.authenticate({ methodId }).catch((error: unknown) => {
        logger.info("Cursor ACP authenticate noop", { threadId, error: messageOf(error) });
      });
    }
    return cursorSupportsHttpMcp(initialized);
  }

  private spawnChild(cwd: string): ChildProcess {
    let lastError: unknown = null;
    for (const cliPath of this.deps.getCliCandidates()) {
      try {
        return spawn(cliPath, buildCursorAcpArgs({ permissionMode: "default" }), {
          stdio: ["pipe", "pipe", "pipe"],
          cwd,
          shell: process.platform === "win32",
          env: this.deps.getEnvironment(),
        });
      } catch (error) {
        lastError = error;
        if (/Failed to spawn cursor-agent/i.test(messageOf(error))) continue;
        break;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "Failed to spawn cursor-agent (side-channel)"));
  }
}

function transientHandoffError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "ETIMEDOUT";
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
