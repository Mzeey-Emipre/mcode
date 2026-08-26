import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@agentclientprotocol/sdk";
import type { ProviderProcessPort } from "../../../host-ports.js";
import type {
  AcpClientFactory,
  AcpSessionCallbacks,
  AcpSessionOpenInput,
  AcpSessionState,
  AcpSessionUpdate,
  AcpSpawnSpec,
} from "./acp-session-types.js";
import { createAcpClientHandlers } from "./acp-client-handlers.js";

/** Result of opening package-private ACP transport before protocol negotiation. */
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
  /** Maximum time to wait for a resumed session/load response. */
  sessionLoadTimeoutMs?: number;
  /** Alias for sessionLoadTimeoutMs used by replay-gate callers. */
  replayGateTimeoutMs?: number;
  /** Server-owned authority for terminating an ACP child before session ownership begins. */
  processes: ProviderProcessPort;
  transportFactory?: (spec: AcpSpawnSpec, client: Client) => Promise<AcpTransport>;
};

type ReplayGate = {
  attemptId: number;
  targetSessionId: string;
  phase: "loading";
  lastReplayAt: number;
  hardDeadline: number;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_SESSION_LOAD_TIMEOUT_MS = 10_000;

/** Owns ACP transport, handshake, logical session setup, prompts, cancellation, and disposal. */
export class AcpSessionRuntime {
  readonly state: AcpSessionState;
  private readonly selectAuthMethod: (methods: readonly { id: string }[]) => string | undefined;
  private readonly clientCapabilities: Record<string, unknown>;
  private readonly clientInfo: { name: string; title: string; version: string };
  private readonly ignoreAuthenticationErrors: boolean;
  private readonly sessionLoadTimeoutMs: number;
  private readonly processes: ProviderProcessPort;
  private promptChain: Promise<void> = Promise.resolve();
  private closed = false;
  private openAttemptId = 0;
  private replayGate: ReplayGate | null = null;
  private openingSession: Promise<{ sessionId: string; reloaded: boolean }> | null = null;

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
    this.processes = options.processes;
    const configuredTimeout = options.replayGateTimeoutMs ?? options.sessionLoadTimeoutMs;
    this.sessionLoadTimeoutMs =
      typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_SESSION_LOAD_TIMEOUT_MS;
  }

  /** Spawns an ACP child and creates its JSON-lines transport. */
  static async start(options: AcpSessionRuntimeOptions): Promise<AcpSessionRuntime> {
    let runtimeRef: AcpSessionRuntime | undefined;
    const callbacks: AcpSessionCallbacks = {
      ...options.callbacks,
      onSessionUpdate: async (update) => {
        const runtime = runtimeRef;
        if (!runtime) return;
        const parsedUpdate = validateAcpSessionUpdate(update);
        if (runtime.replayGate?.phase === "loading" && parsedUpdate.sessionId === runtime.replayGate.targetSessionId) {
          runtime.replayGate.lastReplayAt = Date.now();
          return;
        }
        if (!runtime.state.sessionId || parsedUpdate.sessionId !== runtime.state.sessionId) return;
        await options.callbacks.onSessionUpdate(parsedUpdate);
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
      await terminateAcpChild(options.processes, child);
      throw error;
    }
  }

  /** Performs initialize and optional authentication, returning agent capabilities. */
  async initialize(): Promise<unknown> {
    try {
      const result = validateAcpInitializeResult(await this.state.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: this.clientInfo,
        clientCapabilities: this.clientCapabilities,
      }));
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
    if (this.openingSession) return this.openingSession;
    const opening = this.openSessionAttempt(input);
    this.openingSession = opening;
    try {
      return await opening;
    } finally {
      if (this.openingSession === opening) this.openingSession = null;
    }
  }

  private async openSessionAttempt(input: AcpSessionOpenInput): Promise<{ sessionId: string; reloaded: boolean }> {
    try {
      const loadSessionSupported =
        typeof this.state.agentCapabilities === "object" &&
        this.state.agentCapabilities !== null &&
        (this.state.agentCapabilities as { loadSession?: boolean }).loadSession === true;
      const resumeFrom = input.resumeFrom ? parseAcpIdentifier(input.resumeFrom, "ACP resume session") : undefined;
      if (resumeFrom && loadSessionSupported) {
        const attemptId = ++this.openAttemptId;
        const hardDeadline = Date.now() + this.sessionLoadTimeoutMs;
        let timer!: ReturnType<typeof setTimeout>;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            this.clearReplayGate(attemptId);
            resolve("timeout");
          }, Math.max(0, hardDeadline - Date.now()));
        });
        this.replayGate = {
          attemptId,
          targetSessionId: resumeFrom,
          phase: "loading",
          lastReplayAt: Date.now(),
          hardDeadline,
          timer,
        };

        const load = this.state.connection.loadSession({
          cwd: input.cwd,
          mcpServers: [...input.mcpServers],
          sessionId: resumeFrom,
        }).then(
          () => "loaded" as const,
          (error) => ({ error } as const),
        );
        const outcome = await Promise.race([load, timeout]);
        clearTimeout(timer);

        if (outcome === "loaded" && this.replayGate?.attemptId === attemptId) {
          this.state.sessionId = resumeFrom;
          this.clearReplayGate(attemptId);
          return { sessionId: this.state.sessionId, reloaded: true };
        }
        if (this.openAttemptId !== attemptId) throw new Error("ACP session open superseded");
        this.clearReplayGate(attemptId);
      }
      const created = await this.state.connection.newSession({
        cwd: input.cwd,
        mcpServers: [...input.mcpServers],
      });
      this.state.sessionId = parseAcpIdentifier(created.sessionId, "ACP new session");
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
    this.openAttemptId += 1;
    this.clearReplayGate();
    await terminateAcpChild(this.processes, this.state.child);
  }

  private clearReplayGate(attemptId?: number): void {
    const gate = this.replayGate;
    if (!gate || (attemptId !== undefined && gate.attemptId !== attemptId)) return;
    clearTimeout(gate.timer);
    this.replayGate = null;
  }
}

/** Validates the ACP initialization fields consumed by the generic runtime and provider adapters. */
export function validateAcpInitializeResult(value: unknown): {
  agentCapabilities: Record<string, unknown> | undefined;
  authMethods: readonly { id: string }[];
} {
  const result = requireRecord(value, "ACP initialize result");
  const capabilities = result.agentCapabilities;
  if (capabilities !== undefined && !isRecord(capabilities)) {
    throw invalidAcpPayload("ACP initialize agent capabilities are invalid");
  }
  if (capabilities) validateAgentCapabilities(capabilities);
  const authMethods = result.authMethods;
  if (authMethods === undefined) return { agentCapabilities: capabilities, authMethods: [] };
  if (!Array.isArray(authMethods)) throw invalidAcpPayload("ACP initialize authentication methods are invalid");
  return {
    agentCapabilities: capabilities,
    authMethods: authMethods.map((method) => ({ id: parseAcpIdentifier(requireRecord(method, "ACP authentication method").id, "ACP authentication method") })),
  };
}

/** Validates one ACP notification before it reaches provider-specific event mapping. */
export function validateAcpSessionUpdate(value: unknown): AcpSessionUpdate {
  const update = requireRecord(value, "ACP session update");
  parseAcpIdentifier(update.sessionId, "ACP session update");
  if (!isRecord(update.update) || typeof update.update.sessionUpdate !== "string") {
    throw invalidAcpPayload("ACP session update payload is invalid");
  }
  validateSessionUpdate(update.update);
  return update as AcpSessionUpdate;
}

function validateAgentCapabilities(capabilities: Record<string, unknown>): void {
  if (capabilities.loadSession !== undefined && typeof capabilities.loadSession !== "boolean") {
    throw invalidAcpPayload("ACP initialize agent capabilities are invalid");
  }
  const mcpCapabilities = capabilities.mcpCapabilities;
  if (mcpCapabilities === undefined) return;
  if (!isRecord(mcpCapabilities)) throw invalidAcpPayload("ACP initialize agent capabilities are invalid");
  if (mcpCapabilities.http !== undefined && typeof mcpCapabilities.http !== "boolean") {
    throw invalidAcpPayload("ACP initialize agent capabilities are invalid");
  }
  if (mcpCapabilities.sse !== undefined && typeof mcpCapabilities.sse !== "boolean") {
    throw invalidAcpPayload("ACP initialize agent capabilities are invalid");
  }
}

function validateSessionUpdate(update: Record<string, unknown>): void {
  const sessionUpdate = parseBoundedString(update.sessionUpdate, "ACP session update", 128);
  switch (sessionUpdate) {
    case "agent_message_chunk":
      validateAgentMessageChunk(update);
      return;
    case "plan":
      validatePlanUpdate(update);
      return;
    case "tool_call":
      parseBoundedString(update.toolCallId, "ACP tool call", 512);
      parseBoundedString(update.title, "ACP tool call", 4_000);
      validateOptionalString(update.kind, "ACP tool call", 128);
      return;
    case "tool_call_update":
      parseBoundedString(update.toolCallId, "ACP tool call update", 512);
      validateOptionalString(update.title, "ACP tool call update", 4_000);
      validateOptionalString(update.kind, "ACP tool call update", 128);
      return;
    default:
      return;
  }
}

function validateAgentMessageChunk(update: Record<string, unknown>): void {
  const content = requireRecord(update.content, "ACP agent message content");
  const type = parseBoundedString(content.type, "ACP agent message content", 128);
  if (type === "text") parseBoundedString(content.text, "ACP agent message content", 100_000);
}

function validatePlanUpdate(update: Record<string, unknown>): void {
  if (!Array.isArray(update.entries) || update.entries.length > 1_000) {
    throw invalidAcpPayload("ACP plan update is invalid");
  }
  for (const entry of update.entries) {
    const planEntry = requireRecord(entry, "ACP plan entry");
    parseBoundedString(planEntry.content, "ACP plan entry", 8_000);
    parseBoundedString(planEntry.status, "ACP plan entry", 128);
    validateOptionalString(planEntry.priority, "ACP plan entry", 128);
  }
}

function parseAcpIdentifier(value: unknown, label: string): string {
  return parseBoundedString(value, `${label} identifier`, 512);
}

function parseBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalidAcpPayload(`${label} is invalid`);
  }
  return value;
}

function validateOptionalString(value: unknown, label: string, maxLength: number): void {
  if (value !== undefined && value !== null) parseBoundedString(value, label, maxLength);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidAcpPayload(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidAcpPayload(message: string): TypeError & { code: "INVALID_ACP_PAYLOAD" } {
  return Object.assign(new TypeError(message), { code: "INVALID_ACP_PAYLOAD" as const });
}

async function terminateAcpChild(processes: ProviderProcessPort, child: ChildProcess | undefined): Promise<void> {
  if (child?.pid === undefined) return;
  await processes.terminateTree(child.pid).catch(() => undefined);
}
