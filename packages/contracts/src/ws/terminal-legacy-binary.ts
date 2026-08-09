/**
 * Legacy binary envelope format for PTY output pushed from server to client.
 *
 * Layout (big-endian for multi-byte integers):
 *   byte 0        : tag (0x01 = TERMINAL_DATA)
 *   byte 1        : ptyIdLen (u8)
 *   bytes 2..1+L  : ptyId (UTF-8)
 *   bytes 2+L..5+L: seq (u32 BE)
 *   bytes 6+L..   : payload
 *
 * The tag byte disambiguates this frame type from the binary-upload protocol,
 * which sends an untagged binary frame preceded by a JSON header text frame.
 */

/** Tag byte identifying a terminal.data binary push frame. */
export const TERMINAL_DATA_TAG = 0x01;

/** Decoded view of a terminal.data binary frame. */
export interface TerminalDataFrame {
  readonly ptyId: string;
  readonly seq: number;
  readonly payload: Uint8Array;
}

const HEADER_FIXED_BYTES = 1 /* tag */ + 1 /* ptyIdLen */ + 4 /* seq */;

// Stateless singletons — safe to reuse across calls, avoids per-call allocation.
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

/** Encode a PTY data chunk into a binary frame. */
export function encodeTerminalDataFrame(
  ptyId: string,
  seq: number,
  payload: Uint8Array,
): Uint8Array {
  const ptyIdBytes = _encoder.encode(ptyId);
  if (ptyIdBytes.length > 0xff) {
    throw new Error(`ptyId too long: ${ptyIdBytes.length} bytes`);
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new Error(`seq out of range: ${seq}`);
  }
  const out = new Uint8Array(HEADER_FIXED_BYTES + ptyIdBytes.length + payload.length);
  let off = 0;
  out[off++] = TERMINAL_DATA_TAG;
  out[off++] = ptyIdBytes.length;
  out.set(ptyIdBytes, off);
  off += ptyIdBytes.length;
  // u32 BE
  out[off++] = (seq >>> 24) & 0xff;
  out[off++] = (seq >>> 16) & 0xff;
  out[off++] = (seq >>> 8) & 0xff;
  out[off++] = seq & 0xff;
  out.set(payload, off);
  return out;
}

/** Decode a binary frame into its fields. Throws on tag mismatch or truncation. */
export function decodeTerminalDataFrame(buf: Uint8Array): TerminalDataFrame {
  if (buf.length < 1 || buf[0] !== TERMINAL_DATA_TAG) {
    throw new Error(
      `terminal.data frame: unexpected tag 0x${buf.length > 0 ? buf[0].toString(16) : "?"}`,
    );
  }
  if (buf.length < HEADER_FIXED_BYTES) {
    throw new Error("terminal.data frame truncated (header)");
  }
  const ptyIdLen = buf[1];
  const ptyIdEnd = 2 + ptyIdLen;
  const seqEnd = ptyIdEnd + 4;
  if (buf.length < seqEnd) {
    throw new Error("terminal.data frame truncated (ptyId/seq)");
  }
  const ptyId = _decoder.decode(buf.subarray(2, ptyIdEnd));
  const seq =
    ((buf[ptyIdEnd] << 24) |
      (buf[ptyIdEnd + 1] << 16) |
      (buf[ptyIdEnd + 2] << 8) |
      buf[ptyIdEnd + 3]) >>>
    0;
  const payload = buf.subarray(seqEnd);
  // Return a fresh Uint8Array view so the caller can persist it without aliasing the WS buffer.
  return { ptyId, seq, payload: new Uint8Array(payload) };
}
