#!/usr/bin/env bun
/**
 * Live capture of Cursor `agent acp` `session/update` notifications.
 *
 * Writes JSONL under `<repo>/.mcode-local/cursor-acp-capture/` for comparing raw
 * ACP shapes to mapper output (subagents, read, edit, write, shell, ext methods).
 *
 * Usage (from repo root):
 *   bun apps/server/scripts/capture-cursor-acp.ts
 *   bun apps/server/scripts/capture-cursor-acp.ts --prompt "your message"
 *   bun apps/server/scripts/capture-cursor-acp.ts --suite
 *   bun apps/server/scripts/capture-cursor-acp.ts --smoke
 *
 * Requires `agent` or `cursor-agent` on PATH and a logged-in Cursor CLI session.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { buildCursorAcpArgs } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-spawn-args.js";
import { pickFullAccessAllowOption } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-permission-mapper.js";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
  type CursorAcpTurnState,
} from "../../../packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.js";
import { summarizeEmittedAgentEventsForTrace } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-session-trace.js";
import { cursorTaskExtToAgentEvents } from "../../../packages/providers/src/private/cursor/acp/cursor-acp-task.js";

const REPO_ROOT = NodePath.resolve(import.meta.dir, "../../..");
const OUT_DIR = NodePath.join(REPO_ROOT, ".mcode-local", "cursor-acp-capture");
const SMOKE_CWD = OUT_DIR;
const SMOKE_REQUEST_TIMEOUT_MS = 30_000;
const SMOKE_UPDATE_TIMEOUT_MS = 10_000;
const MAX_SMOKE_RAW_EVENTS = 1_000;
const MAX_SMOKE_MAPPED_EVENTS = 1_000;
const MAX_SMOKE_RAW_BYTES = 2 * 1024 * 1024;
const MAX_SMOKE_MAPPED_BYTES = 2 * 1024 * 1024;
const MAX_SMOKE_STDERR_BYTES = 64 * 1024;
const MAX_SMOKE_STDOUT_BYTES = 4 * 1024;

type SmokeRequirementId =
  | "nativeIdentity"
  | "sessionStart"
  | "continuation"
  | "cancellation"
  | "replayOrFallback";

interface SmokeRequirement {
  passed: boolean;
  detail?: string;
  evidence?: Record<string, unknown>;
}

interface SmokeSummary {
  schemaVersion: 1;
  mode: "smoke";
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: "passed" | "failed";
  cli: string;
  artifacts: {
    raw: string;
    mapped: string;
    summary: string;
  };
  requirements: Record<SmokeRequirementId, SmokeRequirement>;
  error?: string;
}

type CaptureArtifactStream = "raw" | "mapped";

/** Bounds smoke artifacts so an unexpected ACP stream cannot fill local storage. */
class SmokeArtifactWriter {
  private readonly eventCounts: Record<CaptureArtifactStream, number> = { raw: 0, mapped: 0 };
  private readonly byteCounts: Record<CaptureArtifactStream, number> = { raw: 0, mapped: 0 };
  private stderrBytes = 0;
  private stdoutBytes = 0;
  private limitError: Error | undefined;

  constructor(
    private readonly paths: Record<CaptureArtifactStream, string>,
    private readonly onLimit: () => void,
  ) {}

  /** Appends a bounded JSONL record to one smoke artifact. */
  write(stream: CaptureArtifactStream, record: Record<string, unknown>): void {
    if (this.limitError) return;
    const maxEvents = stream === "raw" ? MAX_SMOKE_RAW_EVENTS : MAX_SMOKE_MAPPED_EVENTS;
    if (this.eventCounts[stream] >= maxEvents) {
      this.reachLimit(`${stream} artifact exceeded ${maxEvents} events`);
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    const maxBytes = stream === "raw" ? MAX_SMOKE_RAW_BYTES : MAX_SMOKE_MAPPED_BYTES;
    if (this.byteCounts[stream] + bytes > maxBytes) {
      this.reachLimit(`${stream} artifact exceeded ${maxBytes} bytes`);
      return;
    }
    NodeFS.appendFileSync(this.paths[stream], line, "utf8");
    this.eventCounts[stream] += 1;
    this.byteCounts[stream] += bytes;
  }

  /** Records bounded child stderr as part of the raw smoke artifact. */
  writeStderr(text: string, bytes: number): void {
    if (this.limitError) return;
    if (this.stderrBytes + bytes > MAX_SMOKE_STDERR_BYTES) {
      this.reachLimit(`stderr artifact exceeded ${MAX_SMOKE_STDERR_BYTES} bytes`);
      return;
    }
    this.stderrBytes += bytes;
    this.write("raw", { t: stamp(), kind: "stderr", text });
  }

  /** Writes the machine-readable stdout result within its fixed byte cap. */
  writeStdout(record: Record<string, unknown>): boolean {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.stdoutBytes + bytes > MAX_SMOKE_STDOUT_BYTES) {
      this.reachLimit(`stdout artifact exceeded ${MAX_SMOKE_STDOUT_BYTES} bytes`);
      return false;
    }
    process.stdout.write(line);
    this.stdoutBytes += bytes;
    return true;
  }

  /** Throws after any artifact bound stopped the smoke run. */
  throwIfLimited(): void {
    if (this.limitError) throw this.limitError;
  }

  /** Reports whether an artifact bound stopped the smoke run. */
  isLimited(): boolean {
    return this.limitError !== undefined;
  }

  private reachLimit(detail: string): void {
    if (this.limitError) return;
    this.limitError = new Error(`Cursor ACP smoke failed: ${detail}`);
    this.onLimit();
  }
}

/**
 * Resolves a request path under {@link REPO_ROOT}, rejecting traversal outside the repo.
 */
function resolveWithinRepo(requestPath: string): string {
  return resolveWithin(REPO_ROOT, requestPath, "repo root");
}

/** Resolves a path inside a permitted root and rejects path traversal. */
function resolveWithin(rootPath: string, requestPath: string, rootName: string): string {
  const root = NodePath.resolve(rootPath);
  const candidate = NodePath.resolve(root, requestPath);
  const rel = NodePath.relative(root, candidate);
  if (NodePath.isAbsolute(rel) || rel.startsWith("..") || rel.split(/[/\\]/).includes("..")) {
    throw new Error(`Path escapes ${rootName}: ${requestPath}`);
  }
  return candidate;
}

const FIXTURE_DIR = NodePath.join(OUT_DIR, "fixture-workspace");
const FIXTURE_FILE = NodePath.join(FIXTURE_DIR, "scratch.txt");

/** Scenarios designed to exercise distinct ACP tool_call shapes. */
const CAPTURE_SUITE: Array<{ id: string; prompt: string }> = [
  {
    id: "subagents_parallel",
    prompt:
      "Scenario subagents_parallel: Run exactly two read-only Task subagents in parallel. " +
      "Subagent A: Glob every file under packages/providers/src/private/cursor/. " +
      "Subagent B: Read packages/providers/src/private/cursor/events/cursor-subagent-detection.ts. " +
      "Do not edit repo files. End with a line listing tool names each subagent used.",
  },
  {
    id: "read_and_search",
    prompt:
      "Scenario read_and_search: Without subagents, read packages/providers/src/private/cursor/acp/cursor-acp-task.ts " +
      "and run one repo search (Grep) for 'cursor/task' under packages/providers/. Do not edit files.",
  },
  {
    id: "write_and_edit",
    prompt:
      `Scenario write_and_edit: Only touch ${FIXTURE_FILE.replace(/\\/g, "/")}. ` +
      "If missing, create it with the single line 'before'. Then edit it to replace 'before' with 'after'. " +
      "Do not touch any other path.",
  },
  {
    id: "shell_echo",
    prompt:
      "Scenario shell_echo: Run one terminal command only: echo mcode-acp-capture-ok (or Windows equivalent). " +
      "Do not edit files and do not use subagents.",
  },
  {
    id: "write_create",
    prompt:
      `Scenario write_create: Create a new file only at ${FIXTURE_DIR.replace(/\\/g, "/")}/capture-new.txt ` +
      "with exactly the line 'created-by-acp-capture'. Do not modify any other file.",
  },
  {
    id: "todos_plan",
    prompt:
      "Scenario todos_plan: Without editing repo files, create a short 3-step plan in your reply " +
      "and use your todo/plan tool if available. Steps: inspect, verify, summarize.",
  },
];

const args = process.argv.slice(2);
const useSuite = args.includes("--suite");
const useSmoke = args.includes("--smoke");
const showHelp = args.includes("--help") || args.includes("-h");
const promptFlag = args.indexOf("--prompt");
const singlePrompt =
  promptFlag >= 0 && args[promptFlag + 1]
    ? args.slice(promptFlag + 1).join(" ").trim()
    : CAPTURE_SUITE[0].prompt;
const cliPath = process.env.MCODE_CURSOR_CLI?.trim() || "agent";

if (useSmoke && (useSuite || promptFlag >= 0)) {
  throw new Error("--smoke cannot be combined with --suite or --prompt");
}

function stamp(): string {
  return new Date().toISOString();
}

function writeLine(file: string, record: Record<string, unknown>): void {
  NodeFS.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Returns whether a value can safely be read as a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extracts the ACP update discriminator from one session notification. */
function sessionUpdateKind(params: SessionNotification): string {
  if (!isRecord(params.update)) return "unknown";
  return typeof params.update.sessionUpdate === "string" ? params.update.sessionUpdate : "unknown";
}

/** Returns tool lifecycle fields when the ACP update describes a tool call. */
function toolCallUpdateSlice(params: SessionNotification, updateKind: string): Record<string, unknown> | undefined {
  if (updateKind !== "tool_call" && updateKind !== "tool_call_update") return undefined;
  return isRecord(params.update) ? params.update : undefined;
}

/** Extracts the Cursor tool discriminator only from a safe record payload. */
function cursorToolName(toolCallSlice: Record<string, unknown> | undefined): unknown {
  if (!toolCallSlice || !isRecord(toolCallSlice.rawInput)) return undefined;
  return toolCallSlice.rawInput._toolName;
}

/** Writes one native ACP session update to the capture artifact. */
function writeCapturedSessionUpdate(opts: {
  params: SessionNotification;
  updateKind: string;
  toolCallSlice: Record<string, unknown> | undefined;
  scenarioId: string;
  writeRecord: (stream: CaptureArtifactStream, record: Record<string, unknown>) => void;
}): void {
  const { params, updateKind, toolCallSlice, scenarioId, writeRecord } = opts;
  writeRecord("raw", {
    t: stamp(),
    scenarioId,
    kind: "session_update",
    sessionId: params.sessionId,
    updateKind,
    toolTitle: toolCallSlice?.title,
    toolKind: toolCallSlice?.kind,
    acpToolName: cursorToolName(toolCallSlice),
    payload: params,
  });
}

/** Maps and records one session update for the current Mcode turn. */
function writeMappedSessionUpdate(opts: {
  params: SessionNotification;
  updateKind: string;
  scenarioId: string;
  threadId: string;
  state: CursorAcpTurnState;
  writeRecord: (stream: CaptureArtifactStream, record: Record<string, unknown>) => void;
}): void {
  const { params, updateKind, scenarioId, threadId, state, writeRecord } = opts;
  const mapped = mapCursorAcpSessionNotification(params, threadId, state);
  if (mapped.length === 0) return;
  writeRecord("mapped", {
    t: stamp(),
    scenarioId,
    updateKind,
    mapped: summarizeEmittedAgentEventsForTrace(mapped),
    full: mapped,
  });
}

/** Returns the error text without exposing an error object or stack. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Waits for one protocol operation without allowing the smoke run to wait forever. */
async function withinTimeout<T>(label: string, operation: Promise<T>, timeoutMs = SMOKE_REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs one smoke operation and fails after any bounded artifact reaches its limit. */
async function withinSmokeTimeout<T>(
  artifacts: SmokeArtifactWriter,
  label: string,
  operation: Promise<T>,
  timeoutMs = SMOKE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  artifacts.throwIfLimited();
  const result = await withinTimeout(label, operation, timeoutMs);
  artifacts.throwIfLimited();
  return result;
}

/** Marks a smoke requirement as observed. */
function passSmokeRequirement(
  summary: SmokeSummary,
  id: SmokeRequirementId,
  evidence: Record<string, unknown>,
): void {
  summary.requirements[id] = { passed: true, evidence };
}

/** Marks every requirement without an observation as failed. */
function failMissingSmokeRequirements(summary: SmokeSummary, detail: string): void {
  for (const requirement of Object.values(summary.requirements)) {
    if (!requirement.passed && !requirement.detail) requirement.detail = detail;
  }
}

/** Stops the child process when the bounded smoke run completes or fails. */
function stopChild(child: NodeChildProcess.ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (!child.killed) child.kill();
}

function summarizeRawLog(rawPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    const text = NodeFS.readFileSync(rawPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.kind === "session_update" && typeof row.updateKind === "string") {
        counts[row.updateKind] = (counts[row.updateKind] ?? 0) + 1;
      }
      if (row.kind === "ext_method" && typeof row.method === "string") {
        const key = `ext:${row.method}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  } catch {
    /* empty log */
  }
  return counts;
}

function buildClient(opts: {
  rawPath: string;
  mappedPath: string;
  getTurnState: () => CursorAcpTurnState;
  getSessionId: () => string;
  getScenarioId: () => string;
  approvePermissions?: boolean;
  allowReadTextFile?: boolean;
  allowWriteTextFile?: boolean;
  writeRecord?: (stream: CaptureArtifactStream, record: Record<string, unknown>) => void;
  onSessionUpdate?: (params: SessionNotification, updateKind: string) => void;
}): Client {
  const {
    rawPath,
    mappedPath,
    getTurnState,
    getSessionId,
    getScenarioId,
    approvePermissions = true,
    allowReadTextFile = true,
    allowWriteTextFile = true,
    writeRecord = (stream, record) => writeLine(stream === "raw" ? rawPath : mappedPath, record),
    onSessionUpdate,
  } = opts;

  return {
    sessionUpdate: async (params: SessionNotification) => {
      const updateKind = sessionUpdateKind(params);
      writeCapturedSessionUpdate({
        params,
        updateKind,
        toolCallSlice: toolCallUpdateSlice(params, updateKind),
        scenarioId: getScenarioId(),
        writeRecord,
      });
      onSessionUpdate?.(params, updateKind);

      const sessionId = getSessionId();
      if (!sessionId || params.sessionId !== sessionId) return;
      writeMappedSessionUpdate({
        params,
        updateKind,
        scenarioId: getScenarioId(),
        threadId: "capture-thread",
        state: getTurnState(),
        writeRecord,
      });
    },
    requestPermission: async (req) => {
      const optionId = pickFullAccessAllowOption(req.options);
      writeRecord("raw", {
        t: stamp(),
        scenarioId: getScenarioId(),
        kind: "request_permission",
        title: req.toolCall.title,
        rawInput: req.toolCall.rawInput,
      });
      if (!approvePermissions) return { outcome: { outcome: "cancelled" } };
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    },
    readTextFile: async (r) => {
      if (!allowReadTextFile) throw new Error("ACP text-file reads are disabled for smoke mode");
      const path = resolveWithinRepo(r.path);
      return { content: NodeFS.readFileSync(path, "utf8") };
    },
    writeTextFile: async (r) => {
      if (!allowWriteTextFile) throw new Error("ACP text-file writes are disabled for smoke mode");
      const path = resolveWithinRepo(r.path);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, r.content, "utf8");
      return {};
    },
    extMethod: async (method, params) => {
      writeRecord("raw", {
        t: stamp(),
        scenarioId: getScenarioId(),
        kind: "ext_method",
        method,
        params,
      });
      if (method === "cursor/task" && params && typeof params === "object" && !Array.isArray(params)) {
        const mapped = cursorTaskExtToAgentEvents(
          "capture-thread",
          params as Record<string, unknown>,
          getTurnState(),
        );
        if (mapped.length > 0) {
          writeRecord("mapped", {
            t: stamp(),
            scenarioId: getScenarioId(),
            updateKind: "cursor/task",
            mapped: summarizeEmittedAgentEventsForTrace(mapped),
            full: mapped,
          });
        }
      }
      return {};
    },
    extNotification: async (method, params) => {
      writeRecord("raw", {
        t: stamp(),
        scenarioId: getScenarioId(),
        kind: "ext_notification",
        method,
        params,
      });
    },
  };
}

interface SmokeConnection {
  child: NodeChildProcess.ChildProcess;
  connection: ClientSideConnection;
  initialized: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
}

interface SmokePaths {
  raw: string;
  mapped: string;
  summary: string;
}

interface SmokeRunContext {
  paths: SmokePaths;
  summary: SmokeSummary;
  artifacts: SmokeArtifactWriter;
  primary?: SmokeConnection;
  replay?: SmokeConnection;
  primarySessionId: string;
  primaryTurnState: CursorAcpTurnState;
  replayTurnState: CursorAcpTurnState;
  scenarioId: string;
  cancellationUpdateSeen: boolean;
  cancellationUpdate: Promise<void>;
  resolveCancellationUpdate?: () => void;
}

/** Stops every active child used by a smoke run. */
function stopSmokeConnections(context: SmokeRunContext | undefined): void {
  if (!context) return;
  if (context.replay) stopChild(context.replay.child);
  if (context.primary) stopChild(context.primary.child);
}

/** Captures bounded child stderr and stops the run if it exceeds its limit. */
function attachSmokeStderrCapture(child: NodeChildProcess.ChildProcess, artifacts: SmokeArtifactWriter): void {
  if (!child.stderr) return;
  child.stderr.on("data", (chunk: Buffer) => {
    artifacts.writeStderr(chunk.toString().trim(), Buffer.byteLength(chunk));
    if (artifacts.isLimited()) stopChild(child);
  });
}

/** Writes a smoke artifact record and stops its child after a limit failure. */
function writeSmokeRecord(
  artifacts: SmokeArtifactWriter,
  child: NodeChildProcess.ChildProcess,
  stream: CaptureArtifactStream,
  record: Record<string, unknown>,
): void {
  artifacts.write(stream, record);
  if (artifacts.isLimited()) stopChild(child);
}

/** Builds the restricted ACP client used for smoke connections. */
function createSmokeClientConnection(
  child: NodeChildProcess.ChildProcess,
  opts: Parameters<typeof openSmokeConnection>[0],
): ClientSideConnection {
  const out = NodeStream.Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const inp = NodeStream.Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  return new ClientSideConnection(
    () => buildClient({
      ...opts,
      approvePermissions: false,
      allowReadTextFile: false,
      allowWriteTextFile: false,
      writeRecord: (stream, record) => writeSmokeRecord(opts.artifacts, child, stream, record),
    }),
    ndJsonStream(out, inp),
  );
}

/** Initializes and records the identity of one smoke ACP connection. */
async function initializeSmokeConnection(
  connection: ClientSideConnection,
  artifacts: SmokeArtifactWriter,
): Promise<Awaited<ReturnType<ClientSideConnection["initialize"]>>> {
  const initialized = await withinSmokeTimeout(
    artifacts,
    "ACP initialize",
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "mcode-acp-smoke", title: "Mcode ACP Smoke", version: "0.0.1" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }),
  );
  artifacts.write("raw", {
    t: stamp(),
    kind: "initialize",
    agentInfo: initialized.agentInfo ?? null,
    agentCapabilities: initialized.agentCapabilities ?? null,
    authMethods: initialized.authMethods?.map((method) => method.id) ?? [],
  });
  await authenticateSmokeConnection(connection, artifacts, initialized.authMethods);
  artifacts.throwIfLimited();
  return initialized;
}

/** Attempts the existing Cursor login method when the server advertises it. */
async function authenticateSmokeConnection(
  connection: ClientSideConnection,
  artifacts: SmokeArtifactWriter,
  authMethods: Awaited<ReturnType<ClientSideConnection["initialize"]>>["authMethods"],
): Promise<void> {
  const methodId = authMethods?.find((method) => method.id === "cursor_login")?.id;
  if (!methodId) return;
  const authenticated = await withinSmokeTimeout(
    artifacts,
    "ACP authenticate",
    connection.authenticate({ methodId }),
  )
    .then(() => "succeeded")
    .catch((error: unknown) => `failed: ${messageOf(error)}`);
  artifacts.write("raw", { t: stamp(), kind: "authenticate", methodId, authenticated });
}

/** Opens one constrained ACP connection for the smoke run. */
async function openSmokeConnection(opts: {
  rawPath: string;
  mappedPath: string;
  getTurnState: () => CursorAcpTurnState;
  getSessionId: () => string;
  getScenarioId: () => string;
  artifacts: SmokeArtifactWriter;
  onSessionUpdate: (params: SessionNotification, updateKind: string) => void;
}): Promise<SmokeConnection> {
  const child = NodeChildProcess.spawn(cliPath, buildCursorAcpArgs({ permissionMode: "default" }), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: SMOKE_CWD,
    shell: process.platform === "win32",
  });

  if (!child.stdin || !child.stdout) {
    stopChild(child);
    throw new Error("cursor-agent acp: stdio pipes unavailable");
  }
  attachSmokeStderrCapture(child, opts.artifacts);
  const connection = createSmokeClientConnection(child, opts);

  try {
    const initialized = await initializeSmokeConnection(connection, opts.artifacts);
    return { child, connection, initialized };
  } catch (error) {
    stopChild(child);
    throw error;
  }
}

/** Creates the mutable state and bounded artifacts for one smoke run. */
function createSmokeRunContext(): SmokeRunContext {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const paths: SmokePaths = {
    raw: NodePath.join(OUT_DIR, `${runId}-smoke-raw.jsonl`),
    mapped: NodePath.join(OUT_DIR, `${runId}-smoke-mapped.jsonl`),
    summary: NodePath.join(OUT_DIR, `${runId}-smoke-summary.json`),
  };
  const summary: SmokeSummary = {
    schemaVersion: 1,
    mode: "smoke",
    runId,
    startedAt: stamp(),
    status: "failed",
    cli: cliPath,
    artifacts: paths,
    requirements: {
      nativeIdentity: { passed: false },
      sessionStart: { passed: false },
      continuation: { passed: false },
      cancellation: { passed: false },
      replayOrFallback: { passed: false },
    },
  };
  const activeContext: { current?: SmokeRunContext } = {};
  const artifacts = new SmokeArtifactWriter(
    { raw: paths.raw, mapped: paths.mapped },
    () => stopSmokeConnections(activeContext.current),
  );
  let resolveCancellationUpdate: (() => void) | undefined;
  const cancellationUpdate = new Promise<void>((resolve) => {
    resolveCancellationUpdate = resolve;
  });
  const context: SmokeRunContext = {
    paths,
    summary,
    artifacts,
    primarySessionId: "",
    primaryTurnState: createCursorAcpTurnState(),
    replayTurnState: createCursorAcpTurnState(),
    scenarioId: "initialize",
    cancellationUpdateSeen: false,
    cancellationUpdate,
    resolveCancellationUpdate,
  };
  activeContext.current = context;
  return context;
}

/** Records the first cancellation-phase update for the primary session. */
function recordCancellationUpdate(context: SmokeRunContext, params: SessionNotification): void {
  if (context.scenarioId !== "cancellation") return;
  if (params.sessionId !== context.primarySessionId) return;
  if (context.cancellationUpdateSeen) return;
  context.cancellationUpdateSeen = true;
  context.resolveCancellationUpdate?.();
}

/** Opens the primary smoke connection with live turn state callbacks. */
async function openPrimarySmokeConnection(context: SmokeRunContext): Promise<void> {
  context.primary = await openSmokeConnection({
    rawPath: context.paths.raw,
    mappedPath: context.paths.mapped,
    getTurnState: () => context.primaryTurnState,
    getSessionId: () => context.primarySessionId,
    getScenarioId: () => context.scenarioId,
    artifacts: context.artifacts,
    onSessionUpdate: (params) => recordCancellationUpdate(context, params),
  });
}

/** Records the native identity required for the smoke result. */
function verifySmokeIdentity(context: SmokeRunContext): void {
  const identity = context.primary!.initialized.agentInfo;
  if (identity?.name.trim() && identity.version.trim()) {
    passSmokeRequirement(context.summary, "nativeIdentity", {
      name: identity.name,
      title: identity.title ?? null,
      version: identity.version,
    });
    return;
  }
  if (!context.primarySessionId) throw new Error("ACP did not provide a native agent or session identity");
  passSmokeRequirement(context.summary, "nativeIdentity", {
    sessionId: context.primarySessionId,
    authMethods: context.primary!.initialized.authMethods?.map((method) => method.id) ?? [],
  });
}

/** Creates the primary ACP session and records its stable native ID. */
async function createSmokeSession(context: SmokeRunContext): Promise<void> {
  context.scenarioId = "session_start";
  const created = await withinSmokeTimeout(
    context.artifacts,
    "ACP newSession",
    context.primary!.connection.newSession({ cwd: SMOKE_CWD, mcpServers: [] }),
  );
  if (!created.sessionId) throw new Error("ACP newSession did not return a session id");
  context.primarySessionId = created.sessionId;
  context.artifacts.write("raw", { t: stamp(), kind: "session_created", sessionId: created.sessionId });
  passSmokeRequirement(context.summary, "sessionStart", { sessionId: created.sessionId });
}

/** Runs one prompt that must end normally and records its completion. */
async function runEndTurnSmokePrompt(
  context: SmokeRunContext,
  label: string,
  prompt: string,
): Promise<string> {
  const response = await withinSmokeTimeout(
    context.artifacts,
    label,
    context.primary!.connection.prompt({
      sessionId: context.primarySessionId,
      prompt: [{ type: "text", text: prompt }],
    }),
  );
  if (response.stopReason !== "end_turn") {
    throw new Error(`${label} stopped with ${response.stopReason}`);
  }
  context.artifacts.write("raw", {
    t: stamp(),
    kind: "scenario_complete",
    scenarioId: context.scenarioId,
    stopReason: response.stopReason,
  });
  return response.stopReason;
}

/** Verifies normal continuation on the original ACP session. */
async function runSmokeContinuation(context: SmokeRunContext): Promise<void> {
  context.scenarioId = "continuation_start";
  const firstStopReason = await runEndTurnSmokePrompt(
    context,
    "first same-session prompt",
    "Reply only with MCODE_ACP_SMOKE_START. Do not use tools.",
  );
  context.scenarioId = "continuation";
  context.primaryTurnState = createCursorAcpTurnState();
  const continuationStopReason = await runEndTurnSmokePrompt(
    context,
    "same-session continuation prompt",
    "Reply only with MCODE_ACP_SMOKE_CONTINUATION. Do not use tools.",
  );
  passSmokeRequirement(context.summary, "continuation", {
    sessionId: context.primarySessionId,
    firstStopReason,
    continuationStopReason,
  });
}

/** Confirms that the cancelled prompt reports Cursor's cancelled stop reason. */
function ensureCancelledPrompt(result: { response: { stopReason: string } } | { error: unknown }): string {
  if ("error" in result) throw result.error;
  if (result.response.stopReason !== "cancelled") {
    throw new Error(`Cancelled prompt stopped with ${result.response.stopReason}`);
  }
  return result.response.stopReason;
}

/** Runs a real in-flight prompt cancellation on the primary session. */
async function runSmokeCancellation(context: SmokeRunContext): Promise<void> {
  context.scenarioId = "cancellation";
  context.primaryTurnState = createCursorAcpTurnState();
  context.artifacts.write("raw", { t: stamp(), kind: "scenario_start", scenarioId: context.scenarioId });
  const cancellationOutcome = context.primary!.connection.prompt({
    sessionId: context.primarySessionId,
    prompt: [{
      type: "text",
      text: "Do not use tools or edit files. Write a long numbered list until the client cancels this turn.",
    }],
  }).then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  await withinSmokeTimeout(
    context.artifacts,
    "in-flight cancellation session update",
    context.cancellationUpdate,
    SMOKE_UPDATE_TIMEOUT_MS,
  );
  await withinSmokeTimeout(
    context.artifacts,
    "ACP session/cancel",
    context.primary!.connection.cancel({ sessionId: context.primarySessionId }),
  );
  context.artifacts.write("raw", { t: stamp(), kind: "session_cancelled", sessionId: context.primarySessionId });
  const stopReason = ensureCancelledPrompt(
    await withinSmokeTimeout(context.artifacts, "cancelled prompt response", cancellationOutcome),
  );
  passSmokeRequirement(context.summary, "cancellation", {
    sessionId: context.primarySessionId,
    updateBeforeCancel: context.cancellationUpdateSeen,
    stopReason,
  });
}

/** Opens a fresh connection for session replay or fallback. */
async function openReplaySmokeConnection(context: SmokeRunContext, sessionId: string): Promise<void> {
  context.replay = await openSmokeConnection({
    rawPath: context.paths.raw,
    mappedPath: context.paths.mapped,
    getTurnState: () => context.replayTurnState,
    getSessionId: () => sessionId,
    getScenarioId: () => context.scenarioId,
    artifacts: context.artifacts,
    onSessionUpdate: () => {},
  });
}

/** Creates a fallback session on the active replay connection. */
async function createReplayFallbackSession(context: SmokeRunContext, label: string): Promise<string> {
  const fallback = await withinSmokeTimeout(
    context.artifacts,
    label,
    context.replay!.connection.newSession({ cwd: SMOKE_CWD, mcpServers: [] }),
  );
  if (!fallback.sessionId) throw new Error("ACP fallback newSession did not return a session id");
  return fallback.sessionId;
}

/** Replaces a failed replay connection before a fallback session starts. */
async function runFallbackAfterLoadFailure(context: SmokeRunContext, loadError: unknown): Promise<void> {
  stopChild(context.replay!.child);
  await openReplaySmokeConnection(context, "");
  const fallbackSessionId = await createReplayFallbackSession(
    context,
    "ACP newSession fallback after load failure",
  );
  context.artifacts.write("raw", {
    t: stamp(),
    kind: "session_load_fallback",
    failedSessionId: context.primarySessionId,
    fallbackSessionId,
    loadError: messageOf(loadError),
  });
  passSmokeRequirement(context.summary, "replayOrFallback", {
    mode: "new_session_after_load_failure",
    failedSessionId: context.primarySessionId,
    fallbackSessionId,
    loadSessionAdvertised: true,
  });
}

/** Loads the original session, returning false after a safe fallback starts. */
async function loadSmokeSession(context: SmokeRunContext): Promise<boolean> {
  try {
    await withinSmokeTimeout(
      context.artifacts,
      "ACP loadSession",
      context.replay!.connection.loadSession({
        cwd: SMOKE_CWD,
        mcpServers: [],
        sessionId: context.primarySessionId,
      }),
    );
    context.artifacts.write("raw", {
      t: stamp(),
      kind: "session_loaded",
      sessionId: context.primarySessionId,
      loadSessionAdvertised: true,
    });
    return true;
  } catch (error) {
    context.artifacts.throwIfLimited();
    await runFallbackAfterLoadFailure(context, error);
    return false;
  }
}

/** Verifies the original session remains usable after loadSession. */
async function runPostLoadContinuation(context: SmokeRunContext): Promise<void> {
  context.scenarioId = "post_load_continuation";
  context.replayTurnState = createCursorAcpTurnState();
  const replayResponse = await withinSmokeTimeout(
    context.artifacts,
    "post-load continuation prompt",
    context.replay!.connection.prompt({
      sessionId: context.primarySessionId,
      prompt: [{ type: "text", text: "Reply only with MCODE_ACP_SMOKE_REPLAY. Do not use tools." }],
    }),
  );
  if (replayResponse.stopReason !== "end_turn") {
    throw new Error(`Post-load continuation stopped with ${replayResponse.stopReason}`);
  }
  context.artifacts.write("raw", {
    t: stamp(),
    kind: "scenario_complete",
    scenarioId: context.scenarioId,
    sessionId: context.primarySessionId,
    stopReason: replayResponse.stopReason,
  });
  passSmokeRequirement(context.summary, "replayOrFallback", {
    mode: "load_session_with_continuation",
    sessionId: context.primarySessionId,
    loadSessionAdvertised: true,
    postLoadStopReason: replayResponse.stopReason,
  });
}

/** Records a new session when Cursor does not support session replay. */
async function runFallbackWithoutLoadCapability(context: SmokeRunContext): Promise<void> {
  const fallbackSessionId = await createReplayFallbackSession(
    context,
    "ACP newSession fallback without load capability",
  );
  context.artifacts.write("raw", {
    t: stamp(),
    kind: "session_load_fallback",
    failedSessionId: context.primarySessionId,
    fallbackSessionId,
    reason: "loadSession capability not advertised",
  });
  passSmokeRequirement(context.summary, "replayOrFallback", {
    mode: "new_session_without_load_capability",
    fallbackSessionId,
    loadSessionAdvertised: false,
  });
}

/** Verifies session load or records a clean fallback session. */
async function runSmokeReplayOrFallback(context: SmokeRunContext): Promise<void> {
  context.scenarioId = "replay_or_fallback";
  await openReplaySmokeConnection(context, context.primarySessionId);
  const supportsLoadSession = context.replay!.initialized.agentCapabilities?.loadSession === true;
  if (!supportsLoadSession) {
    await runFallbackWithoutLoadCapability(context);
    return;
  }
  const loaded = await loadSmokeSession(context);
  if (!loaded) return;
  await runPostLoadContinuation(context);
}

/** Finalizes bounded artifacts and sets the smoke pass or fail result. */
function finalizeSmokeRun(context: SmokeRunContext): void {
  stopSmokeConnections(context);
  try {
    context.artifacts.throwIfLimited();
  } catch (error) {
    context.summary.error ??= messageOf(error);
  }
  failMissingSmokeRequirements(context.summary, context.summary.error ?? "Required observation was absent");
  context.summary.finishedAt = stamp();
  context.summary.status = context.summary.error === undefined
    && Object.values(context.summary.requirements).every((requirement) => requirement.passed)
    ? "passed"
    : "failed";
  NodeFS.writeFileSync(context.paths.summary, `${JSON.stringify(context.summary, null, 2)}\n`, "utf8");
  const wroteSummary = context.artifacts.writeStdout({
    type: "smoke_summary",
    status: context.summary.status,
    summary: context.paths.summary,
  });
  if (!wroteSummary) {
    context.summary.error ??= "Cursor ACP smoke failed: stdout summary exceeded its byte limit";
    context.summary.status = "failed";
    NodeFS.writeFileSync(context.paths.summary, `${JSON.stringify(context.summary, null, 2)}\n`, "utf8");
  }
}

/** Runs the bounded live checks required for the Cursor ACP integration. */
async function runSmoke(): Promise<void> {
  const context = createSmokeRunContext();

  try {
    await openPrimarySmokeConnection(context);
    await createSmokeSession(context);
    verifySmokeIdentity(context);
    await runSmokeContinuation(context);
    await runSmokeCancellation(context);
    await runSmokeReplayOrFallback(context);
  } catch (error) {
    context.summary.error = messageOf(error);
  } finally {
    finalizeSmokeRun(context);
  }

  if (context.summary.status !== "passed") {
    throw new Error(`Cursor ACP smoke failed. Read ${context.paths.summary}`);
  }
}

async function runCapture(): Promise<void> {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  NodeFS.mkdirSync(FIXTURE_DIR, { recursive: true });
  try {
    NodeFS.writeFileSync(FIXTURE_FILE, "before\n", "utf8");
  } catch {
    /* ok */
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = NodePath.join(OUT_DIR, `${runId}-raw.jsonl`);
  const mappedPath = NodePath.join(OUT_DIR, `${runId}-mapped.jsonl`);
  const summaryPath = NodePath.join(OUT_DIR, `${runId}-summary.txt`);
  const scenarios = useSuite ? CAPTURE_SUITE : [{ id: "single", prompt: singlePrompt }];

  NodeFS.writeFileSync(
    summaryPath,
    [
      `capture started ${stamp()}`,
      `cwd: ${REPO_ROOT}`,
      `cli: ${cliPath}`,
      `mode: ${useSuite ? "suite" : "single"}`,
      `scenarios: ${scenarios.map((s) => s.id).join(", ")}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const acpArgs = buildCursorAcpArgs({ permissionMode: "full" });
  const child = NodeChildProcess.spawn(cliPath, acpArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("cursor-agent acp: stdio pipes unavailable");
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) writeLine(rawPath, { t: stamp(), kind: "stderr", text });
  });

  const out = NodeStream.Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inp = NodeStream.Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(out, inp);

  let turnState = createCursorAcpTurnState();
  let acpSessionId = "";
  let currentScenarioId = "session";

  const connection = new ClientSideConnection(
    () =>
      buildClient({
        rawPath,
        mappedPath,
        getScenarioId: () => currentScenarioId,
        getTurnState: () => turnState,
        getSessionId: () => acpSessionId,
      }),
    stream,
  );

  console.log("[capture-cursor-acp] initializing...");
  await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "mcode-capture", title: "Mcode ACP Capture", version: "0.0.1" },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });

  await connection.authenticate({ methodId: "cursor_login" }).catch(() => null);

  console.log("[capture-cursor-acp] newSession...");
  const created = await connection.newSession({ cwd: REPO_ROOT, mcpServers: [] });
  acpSessionId = created.sessionId;
  writeLine(rawPath, { t: stamp(), kind: "session_created", sessionId: acpSessionId });

  for (const scenario of scenarios) {
    currentScenarioId = scenario.id;
    turnState = createCursorAcpTurnState();
    console.log(`[capture-cursor-acp] scenario: ${scenario.id}`);
    writeLine(rawPath, { t: stamp(), kind: "scenario_start", scenarioId: scenario.id, prompt: scenario.prompt });

    const response = await connection.prompt({
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: scenario.prompt }],
    });

    writeLine(rawPath, {
      t: stamp(),
      kind: "scenario_complete",
      scenarioId: scenario.id,
      stopReason: response.stopReason,
      usage: response.usage,
    });
    console.log(`[capture-cursor-acp]   stopReason=${response.stopReason}`);
  }

  const counts = summarizeRawLog(rawPath);
  NodeFS.appendFileSync(
    summaryPath,
    [
      "",
      `finished ${stamp()}`,
      `raw log: ${rawPath}`,
      `mapped log: ${mappedPath}`,
      "",
      "Event counts (session_update kinds + ext methods):",
      JSON.stringify(counts, null, 2),
      "",
      "Inspect raw.jsonl for full envelopes (tool_call rawInput, content diffs, cursor/task).",
    ].join("\n"),
    "utf8",
  );

  console.log("[capture-cursor-acp] done");
  console.log("  raw:", rawPath);
  console.log("  mapped:", mappedPath);
  console.log("  summary:", summaryPath);
  console.log("  counts:", JSON.stringify(counts));

  child.kill();
}

if (showHelp) {
  console.log("Usage: bun apps/server/scripts/capture-cursor-acp.ts [--suite | --prompt <message> | --smoke]");
} else {
  const run = useSmoke ? runSmoke : runCapture;
  run().catch((err: unknown) => {
    console.error("[capture-cursor-acp] failed:", err);
    process.exit(1);
  });
}
