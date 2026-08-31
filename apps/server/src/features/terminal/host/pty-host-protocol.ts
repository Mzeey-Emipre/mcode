import * as NodeBuffer from "node:buffer";
import { z } from "zod";
import {
  TERMINAL_CONTRACT_VERSION,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  lazySchema,
  TerminalExecutableSchema,
  TerminalPlatformSchema,
  TerminalProfileArgumentsSchema,
  TerminalScopeSchema,
  TerminalU64Schema,
  TerminalUuidSchema,
} from "@mcode/contracts";

/** Maximum private PTY host IPC message bytes. */
export const PTY_HOST_MAX_MESSAGE_BYTES = 131_072;
/** Maximum decoded PTY host input or output bytes. */
export const PTY_HOST_MAX_DATA_BYTES = 65_536;
/** Maximum retained PTY host messages or events per direction. */
export const PTY_HOST_MAX_RETAINED_RECORDS = 256;
/** Heartbeat interval used by the PTY host and its supervisor. */
export const PTY_HOST_HEARTBEAT_INTERVAL_MS = 250;

const u64 = TerminalU64Schema();
const uuid = TerminalUuidSchema();
const hostGeneration = { hostGeneration: u64 };
const sessionIdentity = { sessionId: uuid, ...hostGeneration };
const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value), "cwd must be absolute");
const envSchema = z
  .array(
    z.object({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      value: z.string().max(8_192),
    }).strict(),
  )
  .max(256)
  .refine((value) => NodeBuffer.Buffer.byteLength(JSON.stringify(value), "utf8") <= 65_536, "env exceeds 64 KiB");
const dataBase64Schema = z
  .string()
  .min(4)
  .max(87_384)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => {
    const decoded = NodeBuffer.Buffer.from(value, "base64");
    return decoded.length >= 1 && decoded.length <= PTY_HOST_MAX_DATA_BYTES && decoded.toString("base64") === value;
  }, "base64 payload exceeds 64 KiB or is noncanonical");
const nativeAbi = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const processGroupId = z.string().min(1).max(128);
const closeReason = z.enum(["user", "scope-reset", "workspace-delete", "app-shutdown"]);
const exitReason = z.enum(["natural", "user-close", "host-crash", "containment-failure", "protocol-failure"]);
const messageSize = <T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> =>
  schema.refine((value) => NodeBuffer.Buffer.byteLength(JSON.stringify(value), "utf8") <= PTY_HOST_MAX_MESSAGE_BYTES, "PTY host message exceeds 128 KiB");

/** Strict server-to-PTY-host protocol schema. */
export const PtyHostServerMessageSchema = lazySchema(() => messageSize(z.discriminatedUnion("kind", [
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("handshake"), requestedGeneration: u64, platform: TerminalPlatformSchema() }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("create"), ...sessionIdentity, scope: TerminalScopeSchema(), executable: TerminalExecutableSchema(), arguments: TerminalProfileArgumentsSchema(), cwd: absolutePath, cols: z.number().int().min(1).max(TERMINAL_MAX_COLS), rows: z.number().int().min(1).max(TERMINAL_MAX_ROWS), env: envSchema }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("command.input"), ...sessionIdentity, attachmentEpoch: u64, commandSeq: u64, dataBase64: dataBase64Schema }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("command.resize"), ...sessionIdentity, attachmentEpoch: u64, commandSeq: u64, cols: z.number().int().min(1).max(TERMINAL_MAX_COLS), rows: z.number().int().min(1).max(TERMINAL_MAX_ROWS) }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("inspectChildren"), ...sessionIdentity }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("close"), ...sessionIdentity, closeSeq: u64, reason: closeReason }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("probe"), ...hostGeneration, nonce: uuid }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("shutdown"), ...hostGeneration, reason: z.literal("app-shutdown") }).strict(),
])));

const hostCapabilitiesSchema = z
  .object({
    pty: z.enum(["conpty", "posix-pty"]),
    containment: z.enum(["job-object", "process-group"]),
    maxSessions: z.literal(20),
    protocolVersion: z.literal(1),
  })
  .strict();

/** Strict PTY-host-to-server event schema. */
export const PtyHostEventSchema = lazySchema(() => messageSize(z.discriminatedUnion("kind", [
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("ready"), ...hostGeneration, platform: TerminalPlatformSchema(), nativeAbi, capabilities: hostCapabilitiesSchema }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("heartbeat"), ...hostGeneration, monotonicMs: u64, activeSessions: z.number().int().min(0).max(20), queueBytes: z.number().int().min(0).max(1_048_576), rssBytes: u64 }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("running"), ...sessionIdentity, rootPid: z.number().int().min(0).max(4_294_967_295), processGroupId, containment: z.enum(["job-object", "process-group"]) }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("commandAck"), ...sessionIdentity, attachmentEpoch: u64, appliedCommandSeq: u64, appliedOutputSeq: u64 }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("output"), ...sessionIdentity, outputSeq: u64, dataBase64: dataBase64Schema }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("children"), ...sessionIdentity, hasChildren: z.boolean() }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("exit"), ...sessionIdentity, finalOutputSeq: u64, code: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(), signal: z.number().int().min(0).max(65_535).nullable(), reason: exitReason }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("containment"), ...sessionIdentity, established: z.boolean(), mechanism: z.enum(["job-object", "process-group"]), processGroupId }).strict(),
  z.object({ contractVersion: z.literal(TERMINAL_CONTRACT_VERSION), kind: z.literal("failure"), ...hostGeneration, boundary: z.enum(["startup", "create", "command", "output", "containment", "shutdown"]), recoverable: z.boolean(), code: z.enum(["HOST_UNHEALTHY", "CONTAINMENT_FAILED", "PROTOCOL_MISMATCH"]) }).strict(),
])));

/** Server-to-PTY-host protocol message. */
export type PtyHostServerMessage = z.infer<ReturnType<typeof PtyHostServerMessageSchema>>;
/** PTY-host-to-server protocol event. */
export type PtyHostEvent = z.infer<ReturnType<typeof PtyHostEventSchema>>;

const messageGeneration = (message: PtyHostServerMessage): string =>
  message.kind === "handshake" ? message.requestedGeneration : message.hostGeneration;

/** Parses a server message and rejects stale host generations before dispatch. */
export function parsePtyHostServerMessage(value: unknown, expectedGeneration: string): PtyHostServerMessage {
  const expected = u64.parse(expectedGeneration);
  const message = PtyHostServerMessageSchema().parse(value);
  if (messageGeneration(message) !== expected) throw new Error("PTY host generation is stale");
  return message;
}

/** Parses a host event and rejects stale host generations before dispatch. */
export function parsePtyHostEvent(value: unknown, expectedGeneration: string): PtyHostEvent {
  const expected = u64.parse(expectedGeneration);
  const event = PtyHostEventSchema().parse(value);
  if (event.hostGeneration !== expected) throw new Error("PTY host generation is stale");
  return event;
}

/** Deterministic bidirectional PTY host protocol seam for contract and runtime tests. */
export class InMemoryPtyHostProtocol {
  private readonly sentMessages: PtyHostServerMessage[] = [];
  private readonly receivedEvents: PtyHostEvent[] = [];
  private readonly outputBySequence = new Map<string, string>();

  constructor(private readonly hostGeneration: string) {
    u64.parse(hostGeneration);
  }

  /** Validates and retains one server message. */
  sendToHost(value: unknown): PtyHostServerMessage {
    const message = parsePtyHostServerMessage(value, this.hostGeneration);
    this.retain(this.sentMessages, message);
    return message;
  }

  /** Validates and retains one host event. */
  receiveFromHost(value: unknown): PtyHostEvent {
    const event = parsePtyHostEvent(value, this.hostGeneration);
    if (event.kind === "output") {
      const key = `${event.hostGeneration}:${event.sessionId}:${event.outputSeq}`;
      const retainedPayload = this.outputBySequence.get(key);
      if (retainedPayload !== undefined && retainedPayload !== event.dataBase64) {
        throw new Error("PTY host duplicate output sequence has different bytes");
      }
      if (retainedPayload === undefined) {
        this.outputBySequence.set(key, event.dataBase64);
        if (this.outputBySequence.size > PTY_HOST_MAX_RETAINED_RECORDS) {
          const oldestKey = this.outputBySequence.keys().next().value;
          if (oldestKey !== undefined) this.outputBySequence.delete(oldestKey);
        }
      }
    }
    this.retain(this.receivedEvents, event);
    return event;
  }

  /** Returns the validated server messages in send order. */
  messages(): readonly PtyHostServerMessage[] {
    return [...this.sentMessages];
  }

  /** Returns the validated host events in receive order. */
  events(): readonly PtyHostEvent[] {
    return [...this.receivedEvents];
  }

  private retain<T>(records: T[], record: T): void {
    records.push(record);
    if (records.length > PTY_HOST_MAX_RETAINED_RECORDS) records.shift();
  }
}
