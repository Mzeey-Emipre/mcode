import { z } from "zod";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_PAYLOAD_BYTES,
  TerminalExitMetadataSchema,
  TerminalGapSchema,
  TerminalHydrationDescriptorSchema,
  TerminalSessionStateSchema,
  TerminalU64Schema,
  TerminalUuidSchema,
} from "../models/terminal.js";

/** Terminal v1 binary magic bytes. */
export const TERMINAL_BINARY_MAGIC = new Uint8Array([0x4d, 0x54]);
/** Fixed Terminal v1 binary header bytes. */
export const TERMINAL_BINARY_HEADER_BYTES = 52;
/** Maximum complete Terminal v1 binary frame bytes. */
export const TERMINAL_BINARY_MAX_FRAME_BYTES = 70_000;

/** Frozen Terminal v1 frame-kind byte assignments. */
export const TERMINAL_BINARY_FRAME_KINDS = {
  input: 0x01,
  resize: 0x02,
  outputAck: 0x03,
  checkpointChunk: 0x04,
  commandAck: 0x81,
  output: 0x82,
  hydrationChunk: 0x83,
  hydrationComplete: 0x84,
  state: 0x85,
  gap: 0x86,
  exitBarrier: 0x87,
} as const;

/** Terminal v1 binary frame kind. */
export type TerminalBinaryFrameKind = keyof typeof TERMINAL_BINARY_FRAME_KINDS;

/** Decoded Terminal v1 binary frame. */
export interface TerminalBinaryFrame {
  readonly kind: TerminalBinaryFrameKind;
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly hydrationId?: string;
  readonly uploadId?: string;
  readonly hostGeneration: string;
  readonly attachmentEpoch: string;
  readonly primarySeq: string;
  readonly relatedSeq: string;
  readonly payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const kindByCode = new Map<number, TerminalBinaryFrameKind>(
  Object.entries(TERMINAL_BINARY_FRAME_KINDS).map(([kind, code]) => [code, kind as TerminalBinaryFrameKind]),
);

const statePayloadSchema = z.object({ state: TerminalSessionStateSchema(), exit: TerminalExitMetadataSchema().nullable() }).strict();
const exitBarrierPayloadSchema = z.object({ finalOutputSeq: TerminalU64Schema(), exit: TerminalExitMetadataSchema() }).strict();

const readJson = <T>(payload: Uint8Array, schema: z.ZodType<T>, label: string): T => {
  try {
    return schema.parse(JSON.parse(decoder.decode(payload)));
  } catch {
    throw new Error(`Invalid Terminal ${label} payload`);
  }
};

const validateUuid = (value: string, label: string): Uint8Array => {
  const parsed = TerminalUuidSchema().safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Terminal ${label}`);
  return encoder.encode(parsed.data);
};

const validateU64 = (value: string, label: string): bigint => {
  const parsed = TerminalU64Schema().safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Terminal ${label}`);
  return BigInt(parsed.data);
};

const validateUtf8 = (payload: Uint8Array, label: string): void => {
  try {
    decoder.decode(payload);
  } catch {
    throw new Error(`Terminal ${label} payload is not valid UTF-8`);
  }
};

const validateIds = (frame: TerminalBinaryFrame): void => {
  const hydrationRequired = ["hydrationChunk", "hydrationComplete", "gap"].includes(frame.kind);
  const hydrationAllowed = hydrationRequired || frame.kind === "output";
  if (hydrationRequired && !frame.hydrationId) throw new Error("Terminal hydration ID is required");
  if (!hydrationAllowed && frame.hydrationId) throw new Error("Terminal hydration ID is unused");
  const uploadRequired = frame.kind === "checkpointChunk";
  if (uploadRequired && !frame.uploadId) throw new Error("Terminal upload ID is required");
  if (!uploadRequired && frame.uploadId) throw new Error("Terminal upload ID is unused");
};

const validatePayload = (frame: TerminalBinaryFrame): void => {
  const { kind, payload } = frame;
  if (payload.byteLength > TERMINAL_MAX_PAYLOAD_BYTES) throw new Error("Terminal payload exceeds 64 KiB");
  if (["input", "output"].includes(kind)) {
    if (payload.byteLength === 0) throw new Error(`Terminal ${kind} payload is empty`);
  }
  if (kind === "input") validateUtf8(payload, kind);
  if (kind === "resize") {
    if (payload.byteLength !== 4) throw new Error("Terminal resize payload must be four bytes");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const cols = view.getUint16(0, false);
    const rows = view.getUint16(2, false);
    if (cols < 1 || cols > TERMINAL_MAX_COLS || rows < 1 || rows > 500) {
      throw new Error("Terminal resize dimensions are out of range");
    }
  }
  if (["outputAck", "commandAck"].includes(kind) && payload.byteLength !== 0) {
    throw new Error(`Terminal ${kind} payload must be empty`);
  }
  if (["input", "resize", "outputAck", "output", "hydrationComplete", "state"].includes(kind) && frame.relatedSeq !== "0") {
    throw new Error(`Terminal ${kind} related sequence must be zero`);
  }
  if (["checkpointChunk", "hydrationChunk"].includes(kind)) {
    if (payload.byteLength === 0) throw new Error(`Terminal ${kind} payload is empty`);
    const chunks = BigInt(frame.relatedSeq);
    const index = BigInt(frame.primarySeq);
    if (chunks < 1n || chunks > 128n || index >= chunks) throw new Error(`Terminal ${kind} sequence is invalid`);
  }
  if (kind === "hydrationComplete") {
    if (payload.byteLength > 4_096) throw new Error("Terminal hydration payload exceeds 4 KiB");
    const descriptor = readJson(payload, TerminalHydrationDescriptorSchema(), "hydrationComplete");
    if (descriptor.lastOutputSeq !== null && descriptor.lastOutputSeq !== frame.primarySeq) {
      throw new Error("Terminal hydrationComplete sequence does not match its payload");
    }
  }
  if (kind === "state") {
    if (payload.byteLength > 2_048) throw new Error("Terminal state payload exceeds 2 KiB");
    readJson(payload, statePayloadSchema, "state");
  }
  if (kind === "gap") {
    if (payload.byteLength > 2_048) throw new Error("Terminal gap payload exceeds 2 KiB");
    const gap = readJson(payload, TerminalGapSchema(), "gap");
    if (gap.firstMissingSeq !== frame.primarySeq || gap.lastMissingSeq !== frame.relatedSeq) {
      throw new Error("Terminal gap sequence does not match its payload");
    }
  }
  if (kind === "exitBarrier") {
    if (payload.byteLength > 2_048) throw new Error("Terminal exit payload exceeds 2 KiB");
    const barrier = readJson(payload, exitBarrierPayloadSchema, "exitBarrier");
    if (barrier.finalOutputSeq !== frame.primarySeq) {
      throw new Error("Terminal exitBarrier sequence does not match its payload");
    }
  }
};

/** Encodes one strict Terminal v1 binary frame. */
export function encodeTerminalFrame(frame: TerminalBinaryFrame): Uint8Array {
  validateIds(frame);
  const session = validateUuid(frame.sessionId, "session ID");
  const attachment = validateUuid(frame.attachmentId, "attachment ID");
  const hydration = frame.hydrationId ? validateUuid(frame.hydrationId, "hydration ID") : new Uint8Array();
  const upload = frame.uploadId ? validateUuid(frame.uploadId, "upload ID") : new Uint8Array();
  const hostGeneration = validateU64(frame.hostGeneration, "host generation");
  const attachmentEpoch = validateU64(frame.attachmentEpoch, "attachment epoch");
  const primarySeq = validateU64(frame.primarySeq, "primary sequence");
  const relatedSeq = validateU64(frame.relatedSeq, "related sequence");
  validatePayload(frame);

  const length = TERMINAL_BINARY_HEADER_BYTES + session.length + attachment.length + hydration.length + upload.length + frame.payload.length;
  if (length > TERMINAL_BINARY_MAX_FRAME_BYTES) throw new Error("Terminal frame exceeds 70,000 bytes");
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(TERMINAL_BINARY_MAGIC, 0);
  view.setUint8(2, 1);
  view.setUint8(3, TERMINAL_BINARY_FRAME_KINDS[frame.kind]);
  view.setUint16(4, 0, false);
  view.setUint16(6, session.length, false);
  view.setUint16(8, attachment.length, false);
  view.setUint16(10, hydration.length, false);
  view.setUint16(12, upload.length, false);
  view.setBigUint64(14, hostGeneration, false);
  view.setBigUint64(22, attachmentEpoch, false);
  view.setBigUint64(30, primarySeq, false);
  view.setBigUint64(38, relatedSeq, false);
  view.setUint32(46, frame.payload.length, false);
  view.setUint16(50, 0, false);
  let offset = TERMINAL_BINARY_HEADER_BYTES;
  for (const value of [session, attachment, hydration, upload, frame.payload]) {
    bytes.set(value, offset);
    offset += value.length;
  }
  return bytes;
}

/** Decodes and validates one strict Terminal v1 binary frame. */
export function decodeTerminalFrame(bytes: Uint8Array): TerminalBinaryFrame {
  if (bytes.length < TERMINAL_BINARY_HEADER_BYTES) throw new Error("Terminal frame header is truncated");
  if (bytes.length > TERMINAL_BINARY_MAX_FRAME_BYTES) throw new Error("Terminal frame exceeds 70,000 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== TERMINAL_BINARY_MAGIC[0] || bytes[1] !== TERMINAL_BINARY_MAGIC[1]) throw new Error("Terminal frame magic is invalid");
  if (view.getUint8(2) !== 1) throw new Error("Terminal frame version is unsupported");
  const kind = kindByCode.get(view.getUint8(3));
  if (!kind) throw new Error("Terminal frame kind is unsupported");
  if (view.getUint16(4, false) !== 0) throw new Error("Terminal frame flags must be zero");
  if (view.getUint16(50, false) !== 0) throw new Error("Terminal frame reserved bytes must be zero");
  const sessionLength = view.getUint16(6, false);
  const attachmentLength = view.getUint16(8, false);
  const hydrationLength = view.getUint16(10, false);
  const uploadLength = view.getUint16(12, false);
  if (sessionLength !== 36 || attachmentLength !== 36 || ![0, 36].includes(hydrationLength) || ![0, 36].includes(uploadLength)) {
    throw new Error("Terminal frame ID lengths are invalid");
  }
  const payloadLength = view.getUint32(46, false);
  if (payloadLength > TERMINAL_MAX_PAYLOAD_BYTES) throw new Error("Terminal payload exceeds 64 KiB");
  const expected = TERMINAL_BINARY_HEADER_BYTES + sessionLength + attachmentLength + hydrationLength + uploadLength + payloadLength;
  if (bytes.length !== expected) throw new Error("Terminal frame length has truncation or trailing bytes");
  let offset = TERMINAL_BINARY_HEADER_BYTES;
  const readId = (length: number): string | undefined => {
    if (length === 0) return undefined;
    const value = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const frame: TerminalBinaryFrame = {
    kind,
    sessionId: readId(sessionLength)!,
    attachmentId: readId(attachmentLength)!,
    ...(hydrationLength ? { hydrationId: readId(hydrationLength)! } : {}),
    ...(uploadLength ? { uploadId: readId(uploadLength)! } : {}),
    hostGeneration: view.getBigUint64(14, false).toString(),
    attachmentEpoch: view.getBigUint64(22, false).toString(),
    primarySeq: view.getBigUint64(30, false).toString(),
    relatedSeq: view.getBigUint64(38, false).toString(),
    payload: new Uint8Array(bytes.subarray(offset, offset + payloadLength)),
  };
  validateUuid(frame.sessionId, "session ID");
  validateUuid(frame.attachmentId, "attachment ID");
  if (frame.hydrationId) validateUuid(frame.hydrationId, "hydration ID");
  if (frame.uploadId) validateUuid(frame.uploadId, "upload ID");
  validateIds(frame);
  validatePayload(frame);
  return frame;
}
