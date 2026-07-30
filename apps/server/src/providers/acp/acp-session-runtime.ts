import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@agentclientprotocol/sdk";
import type {
  AcpClientFactory,
  AcpSessionCallbacks,
  AcpSessionOpenInput,
  AcpSessionState,
  AcpSpawnSpec,
} from "./acp-session-types.js";
import { createAcpClientHandlers } from "./acp-client-handlers.js";

/** Result of opening the ACP transport before protocol negotiation. */
export type AcpTransport = {
  child: ChildProcess;
  connection: ClientSideConnection;
};

/** Options for creating one generic ACP runtime. */
export type AcpSessionRuntimeOptions = {
  spawnSpec: AcpSpawnSpec;
  callbacks: AcpSessionCallbacks;
  clientFactory?: AcpClientFactory;
  clientInfo?: { name: string; title: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  selectAuthMethod?: (methods: readonly { id: string }[]) => string | undefined;
  ignoreAuthenticationErrors?: boolean;
  transportFactory?: (spec: AcpSpawnSpec, client: Client) => Promise<AcpTransport>;
};

/** Owns ACP transport, handshake, logical session setup, prompts, cancellation, and disposal. */
export class AcpSessionRuntime {
  readonly state: AcpSessionState;
  private readonly selectAuthMethod: (methods: readonly { id: string }[]) => string | undefined;
  private readonly clientCapabilities: Record<string, unknown>;
  private readonly clientInfo: { name: string; title: string; version: string };
  private readonly ignoreAuthenticationErrors: boolean;
  private promptChain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    transport: AcpTransport,
    options: AcpSessionRuntimeOptions,
  ) {
    this.state = {
      child: transport.child,
      connection: transport.connection,
      sessionId: "",
      agentCapabilities: undefined,
      activePrompt: null,
    };
    this.selectAuthMethod = options.selectAuthMethod ?? ((methods) => methods[0]?.id);
    this.clientCapabilities = options.clientCapabilities ?? {
      fs: { readTextFile: true, writeTextFile: true },
    };
    this.clientInfo = options.clientInfo ?? { name: "mcode", title: "Mcode", version: "0.0.1" };
    this.ignoreAuthenticationErrors = options.ignoreAuthenticationErrors ?? false;
  }

  /** Spawns an ACP child and creates its JSON-lines transport. */
  static async start(options: AcpSessionRuntimeOptions): Promise<AcpSessionRuntime> {
    let runtimeRef: AcpSessionRuntime | undefined;
    const callbacks: AcpSessionCallbacks = {
      ...options.callbacks,
      onSessionUpdate: async (update) => {
        if (runtimeRef?.state.sessionId && update.sessionId !== runtimeRef.state.sessionId) return;
        await options.callbacks.onSessionUpdate(update);
      },
    };
    if (options.transportFactory) {
      const client = (options.clientFactory ?? createAcpClientHandlers)(callbacks);
      runtimeRef = new AcpSessionRuntime(
        await options.transportFactory(options.spawnSpec, client),
        options,
      );
      return runtimeRef;
    }
    let child: ChildProcess | undefined;
    try {
      child = spawn(options.spawnSpec.command, [...options.spawnSpec.args], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: options.spawnSpec.cwd,
        env: options.spawnSpec.env,
        shell: process.platform === "win32",
      });
      if (!child.stdin || !child.stdout) throw new Error("ACP stdio pipes unavailable");
      const client: Client = (options.clientFactory ?? createAcpClientHandlers)(callbacks);
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const connection = new ClientSideConnection(() => client, stream);
      runtimeRef = new AcpSessionRuntime({ child, connection }, options);
      return runtimeRef;
    } catch (error) {
      try { child?.kill(); } catch { /* best effort */ }
      throw error;
    }
  }

  /** Performs initialize and optional authentication, returning agent capabilities. */
  async initialize(): Promise<unknown> {
    try {
      const result = await this.state.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: this.clientInfo,
        clientCapabilities: this.clientCapabilities,
      });
      this.state.agentCapabilities = result.agentCapabilities;
      const methodId = this.selectAuthMethod(result.authMethods ?? []);
      if (methodId) {
        try {
          await this.state.connection.authenticate({ methodId });
        } catch (error) {
          if (!this.ignoreAuthenticationErrors) throw error;
        }
      }
      return result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Opens a logical session, loading a persisted id only when requested. */
  async openSession(input: AcpSessionOpenInput): Promise<{ sessionId: string; reloaded: boolean }> {
    if (this.state.sessionId) return { sessionId: this.state.sessionId, reloaded: true };
    try {
      if (input.resumeFrom) {
        try {
          await this.state.connection.loadSession({
            cwd: input.cwd,
            mcpServers: [...input.mcpServers],
            sessionId: input.resumeFrom,
          });
          this.state.sessionId = input.resumeFrom;
          return { sessionId: this.state.sessionId, reloaded: true };
        } catch {
          // Providers may choose to fall back to a fresh session after load failure.
        }
      }
      const created = await this.state.connection.newSession({
        cwd: input.cwd,
        mcpServers: [...input.mcpServers],
      });
      this.state.sessionId = created.sessionId;
      return { sessionId: this.state.sessionId, reloaded: false };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Serializes prompts for this logical ACP session. */
  async prompt<T>(prompt: { sessionId?: string; prompt: readonly unknown[] }): Promise<T> {
    const run = this.promptChain.then(async () => {
      const response = await this.state.connection.prompt({
        sessionId: prompt.sessionId ?? this.state.sessionId,
        prompt: [...prompt.prompt] as never,
      });
      return response as T;
    });
    this.promptChain = run.then(() => undefined, () => undefined);
    this.state.activePrompt = run;
    try { return await run; } finally {
      if (this.state.activePrompt === run) this.state.activePrompt = null;
    }
  }

  /** Cancels the active prompt for this logical session. */
  async cancel(): Promise<void> {
    if (!this.state.sessionId) return;
    await this.state.connection.cancel({ sessionId: this.state.sessionId });
  }

  /** Disposes the ACP transport and child after setup or runtime failure. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.state.child.kill(); } catch { /* best effort */ }
  }
}
