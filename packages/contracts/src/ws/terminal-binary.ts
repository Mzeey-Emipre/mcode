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
export const TERMINAL_BINARY_FRAME_KINDS = Object.freeze({
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
} as const);

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
  if (frame.payload.byteLength > TERMINAL_MAX_PAYLOAD_BYTES) {
    throw new Error("Terminal payload exceeds 64 KiB");
  }
  validateNonEmptyPayload(frame);
  validateRelatedSequence(frame);
  PAYLOAD_VALIDATORS[frame.kind]?.(frame);
};

const ZERO_RELATED_SEQUENCE_KINDS = new Set<TerminalBinaryFrameKind>([
  "input",
  "resize",
  "outputAck",
  "output",
  "hydrationComplete",
  "state",
]);

const PAYLOAD_VALIDATORS: Partial<Record<TerminalBinaryFrameKind, (frame: TerminalBinaryFrame) => void>> = {
  input: validateInputPayload,
  resize: validateResizePayload,
  outputAck: validateEmptyPayload,
  commandAck: validateEmptyPayload,
  checkpointChunk: validateChunkPayload,
  hydrationChunk: validateChunkPayload,
  hydrationComplete: validateHydrationPayload,
  state: validateStatePayload,
  gap: validateGapPayload,
  exitBarrier: validateExitBarrierPayload,
};

function validateNonEmptyPayload(frame: TerminalBinaryFrame): void {
  if (["input", "output"].includes(frame.kind) && frame.payload.byteLength === 0) {
    throw new Error(`Terminal ${frame.kind} payload is empty`);
  }
}

function validateRelatedSequence(frame: TerminalBinaryFrame): void {
  if (ZERO_RELATED_SEQUENCE_KINDS.has(frame.kind) && frame.relatedSeq !== "0") {
    throw new Error(`Terminal ${frame.kind} related sequence must be zero`);
  }
}

function validateInputPayload(frame: TerminalBinaryFrame): void {
  validateUtf8(frame.payload, frame.kind);
}

function validateResizePayload(frame: TerminalBinaryFrame): void {
  if (frame.payload.byteLength !== 4) throw new Error("Terminal resize payload must be four bytes");
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
  const cols = view.getUint16(0, false);
  const rows = view.getUint16(2, false);
  if (cols < 1 || cols > TERMINAL_MAX_COLS || rows < 1 || rows > 500) {
    throw new Error("Terminal resize dimensions are out of range");
  }
}

function validateEmptyPayload(frame: TerminalBinaryFrame): void {
  if (frame.payload.byteLength !== 0) throw new Error(`Terminal ${frame.kind} payload must be empty`);
}

function validateChunkPayload(frame: TerminalBinaryFrame): void {
  if (frame.payload.byteLength === 0) throw new Error(`Terminal ${frame.kind} payload is empty`);
  const chunks = BigInt(frame.relatedSeq);
  const index = BigInt(frame.primarySeq);
  if (chunks < 1n || chunks > 128n || index >= chunks) throw new Error(`Terminal ${frame.kind} sequence is invalid`);
}

function validateHydrationPayload(frame: TerminalBinaryFrame): void {
  if (frame.payload.byteLength > 4_096) throw new Error("Terminal hydration payload exceeds 4 KiB");
  const descriptor = readJson(frame.payload, TerminalHydrationDescriptorSchema(), "hydrationComplete");
  if (descriptor.lastOutputSeq !== null && descriptor.lastOutputSeq !== frame.primarySeq) {
    throw new Error("Terminal hydrationComplete sequence does not match its payload");
  }
}

function validateStatePayload(frame: TerminalBinaryFrame): void {
  if (frame.payload.byteLength > 2_048) throw new Error("Terminal state payload exceeds 2 KiB");
  readJson(frame.payload, statePayloadSchema, "state");
}

function validateGapPayload(frame: TerminalBinaryFrame): void {
  if (frame.payload.byteLength > 2_048) throw new Error("Terminal gap payload exceeds 2 KiB");
  const gap = readJson(frame.payload, TerminalGapSchema(), "gap");
  if (gap.firstMissingSeq !== frame.primarySeq || gap.lastMissingSeq !== frame.relatedSeq) {
    throw new Error("Terminal gap sequence does not match its payload");
  }
}

function validateExitBarrierPayload(frame: TerminalBinaryFrame): void {
  if (frame.payload.byteLength > 2_048) throw new Error("Terminal exit payload exceeds 2 KiB");
  const barrier = readJson(frame.payload, exitBarrierPayloadSchema, "exitBarrier");
  if (barrier.finalOutputSeq !== frame.primarySeq) {
    throw new Error("Terminal exitBarrier sequence does not match its payload");
  }
}

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
  const header = decodeTerminalFrameHeader(bytes);
  const reader = { bytes, offset: TERMINAL_BINARY_HEADER_BYTES };
  const frame = decodeTerminalFrameBody(header, reader);
  validateDecodedFrameIds(frame);
  validateIds(frame);
  validatePayload(frame);
  return frame;
}

type DecodedTerminalFrameHeader = {
  readonly kind: TerminalBinaryFrameKind;
  readonly view: DataView;
  readonly sessionLength: number;
  readonly attachmentLength: number;
  readonly hydrationLength: number;
  readonly uploadLength: number;
  readonly payloadLength: number;
};

function decodeTerminalFrameHeader(bytes: Uint8Array): DecodedTerminalFrameHeader {
  validateTerminalFrameLength(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  validateTerminalFramePrefix(bytes, view);
  const kind = decodeTerminalFrameKind(view);
  const lengths = decodeTerminalFrameLengths(view);
  validateTerminalFrameBodyLength(bytes.length, lengths);
  return { kind, view, ...lengths };
}

function validateTerminalFrameLength(bytes: Uint8Array): void {
  if (bytes.length < TERMINAL_BINARY_HEADER_BYTES) throw new Error("Terminal frame header is truncated");
  if (bytes.length > TERMINAL_BINARY_MAX_FRAME_BYTES) throw new Error("Terminal frame exceeds 70,000 bytes");
}

function validateTerminalFramePrefix(bytes: Uint8Array, view: DataView): void {
  if (bytes[0] !== TERMINAL_BINARY_MAGIC[0] || bytes[1] !== TERMINAL_BINARY_MAGIC[1]) {
    throw new Error("Terminal frame magic is invalid");
  }
  if (view.getUint8(2) !== 1) throw new Error("Terminal frame version is unsupported");
  if (view.getUint16(4, false) !== 0) throw new Error("Terminal frame flags must be zero");
  if (view.getUint16(50, false) !== 0) throw new Error("Terminal frame reserved bytes must be zero");
}

function decodeTerminalFrameKind(view: DataView): TerminalBinaryFrameKind {
  const kind = kindByCode.get(view.getUint8(3));
  if (!kind) throw new Error("Terminal frame kind is unsupported");
  return kind;
}

function decodeTerminalFrameLengths(view: DataView): Omit<DecodedTerminalFrameHeader, "kind" | "view"> {
  const sessionLength = view.getUint16(6, false);
  const attachmentLength = view.getUint16(8, false);
  const hydrationLength = view.getUint16(10, false);
  const uploadLength = view.getUint16(12, false);
  validateTerminalFrameIdLengths(sessionLength, attachmentLength, hydrationLength, uploadLength);
  const payloadLength = view.getUint32(46, false);
  if (payloadLength > TERMINAL_MAX_PAYLOAD_BYTES) throw new Error("Terminal payload exceeds 64 KiB");
  return { sessionLength, attachmentLength, hydrationLength, uploadLength, payloadLength };
}

function validateTerminalFrameIdLengths(
  sessionLength: number,
  attachmentLength: number,
  hydrationLength: number,
  uploadLength: number,
): void {
  if (sessionLength === 36 && attachmentLength === 36 && [0, 36].includes(hydrationLength) && [0, 36].includes(uploadLength)) return;
  throw new Error("Terminal frame ID lengths are invalid");
}

function validateTerminalFrameBodyLength(
  byteLength: number,
  lengths: Omit<DecodedTerminalFrameHeader, "kind" | "view">,
): void {
  const expected = TERMINAL_BINARY_HEADER_BYTES + lengths.sessionLength + lengths.attachmentLength + lengths.hydrationLength + lengths.uploadLength + lengths.payloadLength;
  if (byteLength !== expected) throw new Error("Terminal frame length has truncation or trailing bytes");
}

function decodeTerminalFrameBody(
  header: DecodedTerminalFrameHeader,
  reader: { readonly bytes: Uint8Array; offset: number },
): TerminalBinaryFrame {
  const sessionId = readTerminalFrameId(reader, header.sessionLength)!;
  const attachmentId = readTerminalFrameId(reader, header.attachmentLength)!;
  const hydrationId = readTerminalFrameId(reader, header.hydrationLength);
  const uploadId = readTerminalFrameId(reader, header.uploadLength);
  return {
    kind: header.kind,
    sessionId,
    attachmentId,
    ...optionalTerminalFrameIds(hydrationId, uploadId),
    hostGeneration: header.view.getBigUint64(14, false).toString(),
    attachmentEpoch: header.view.getBigUint64(22, false).toString(),
    primarySeq: header.view.getBigUint64(30, false).toString(),
    relatedSeq: header.view.getBigUint64(38, false).toString(),
    payload: new Uint8Array(reader.bytes.subarray(reader.offset, reader.offset + header.payloadLength)),
  };
}

function readTerminalFrameId(reader: { readonly bytes: Uint8Array; offset: number }, length: number): string | undefined {
  if (length === 0) return undefined;
  const value = decoder.decode(reader.bytes.subarray(reader.offset, reader.offset + length));
  reader.offset += length;
  return value;
}

function optionalTerminalFrameIds(hydrationId: string | undefined, uploadId: string | undefined): Pick<TerminalBinaryFrame, "hydrationId" | "uploadId"> {
  return { ...(hydrationId ? { hydrationId } : {}), ...(uploadId ? { uploadId } : {}) };
}

function validateDecodedFrameIds(frame: TerminalBinaryFrame): void {
  validateUuid(frame.sessionId, "session ID");
  validateUuid(frame.attachmentId, "attachment ID");
  if (frame.hydrationId) validateUuid(frame.hydrationId, "hydration ID");
  if (frame.uploadId) validateUuid(frame.uploadId, "upload ID");
}
