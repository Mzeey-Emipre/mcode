import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir, logger } from "@mcode/shared";

/** Maximum tool or sub-agent output bytes sent through the live event stream. */
export const TOOL_OUTPUT_PREVIEW_BYTES = 256 * 1024;

/** Bytes retained from the start of a truncated output preview. */
export const TOOL_OUTPUT_HEAD_BYTES = 192 * 1024;

/** Bytes retained from the end of a truncated output preview. */
export const TOOL_OUTPUT_TAIL_BYTES = 64 * 1024;

/** Milliseconds before stale tool-output artifacts are eligible for cleanup. */
export const TOOL_OUTPUT_ARTIFACT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Flush full-output artifact data in bounded batches instead of per delta. */
const TOOL_OUTPUT_ARTIFACT_FLUSH_BYTES = 64 * 1024;

/** Bounded output data emitted in a ToolResult event. */
export interface BoundedToolOutputResult {
  /** Preview text retained in memory and sent to the client. */
  output: string;
  /** True when the emitted output omits middle bytes from the full output. */
  outputTruncated: boolean;
  /** UTF-8 byte count for the full output. */
  outputTotalBytes: number;
  /** Absolute path to the full output artifact when one was written. */
  outputArtifactPath?: string;
}

/**
 * Resolve the full-output artifact path for one tool result.
 */
export function resolveToolOutputArtifactPath(threadId: string, toolCallId: string): string {
  return NodePath.join(
    getMcodeDir(),
    "artifacts",
    "tool-output",
    safeArtifactSegment(threadId, "thread"),
    `${safeArtifactSegment(toolCallId, "tool")}.txt`,
  );
}

/**
 * Create a bounded result for non-streamed tool output.
 */
export function boundToolOutput(args: {
  threadId: string;
  toolCallId: string;
  output: string;
  forceArtifact?: boolean;
}): BoundedToolOutputResult {
  const buffer = new BoundedToolOutputBuffer(args.threadId, args.toolCallId, {
    forceArtifact: args.forceArtifact,
  });
  buffer.append(args.output);
  return buffer.finalize();
}

/**
 * Streaming output accumulator that keeps only a head/tail preview in memory.
 */
export class BoundedToolOutputBuffer {
  private head = "";
  private headBytes = 0;
  private tail = "";
  private tailBytes = 0;
  private totalBytes = 0;
  private artifactPath: string | undefined;
  private artifactStarted = false;
  private artifactChunks: string[] = [];
  private artifactChunkBytes = 0;
  private forceArtifact: boolean;

  /** Create a bounded accumulator for one tool call. */
  constructor(
    private readonly threadId: string,
    private readonly toolCallId: string,
    opts: { forceArtifact?: boolean } = {},
  ) {
    this.forceArtifact = opts.forceArtifact === true;
  }

  /** Switch artifact spooling on or off for future chunks. */
  setForceArtifact(enabled: boolean): void {
    this.forceArtifact = enabled;
  }

  /** Append one streamed output chunk without concatenating the full output. */
  append(chunk: string): void {
    if (!chunk) return;
    const chunkBytes = byteLength(chunk);
    const nextTotal = this.totalBytes + chunkBytes;
    const shouldStartArtifact = this.forceArtifact || nextTotal > TOOL_OUTPUT_PREVIEW_BYTES;

    if (shouldStartArtifact && !this.artifactStarted) {
      this.startArtifact();
      this.queueArtifactChunk(this.previewSoFar());
    }
    if (this.artifactStarted) {
      this.queueArtifactChunk(chunk);
    }

    this.totalBytes = nextTotal;
    this.retainPreview(chunk, chunkBytes);
  }

  /** Replace retained preview text with a full-text snapshot when it extends the stream. */
  replaceWith(text: string): void {
    this.head = "";
    this.headBytes = 0;
    this.tail = "";
    this.tailBytes = 0;
    this.totalBytes = 0;
    this.artifactChunks = [];
    this.artifactChunkBytes = 0;
    if (this.artifactStarted && this.artifactPath) {
      NodeFS.writeFileSync(this.artifactPath, "", { encoding: "utf8", mode: 0o600 });
    }
    this.append(text);
  }

  /** Preview retained for small-output deduplication. */
  retainedText(): string {
    return this.previewSoFar();
  }

  /** Current full-output byte count seen by this buffer. */
  totalByteLength(): number {
    return this.totalBytes;
  }

  /** True once the retained preview has dropped middle bytes. */
  isPreviewTruncated(): boolean {
    return this.totalBytes > TOOL_OUTPUT_PREVIEW_BYTES;
  }

  /** Return the bounded result for this output. */
  finalize(fallback = ""): BoundedToolOutputResult {
    if (this.totalBytes === 0 && fallback) {
      this.append(fallback);
    }

    const outputTruncated = this.totalBytes > TOOL_OUTPUT_PREVIEW_BYTES;
    if (outputTruncated) {
      this.flushArtifactChunks();
    } else if (this.artifactStarted && this.artifactPath) {
      this.artifactChunks = [];
      this.artifactChunkBytes = 0;
      NodeFS.rmSync(this.artifactPath, { force: true });
      this.artifactStarted = false;
      this.artifactPath = undefined;
    }
    return {
      output: this.previewSoFar(),
      outputTruncated,
      outputTotalBytes: this.totalBytes,
      ...(outputTruncated && this.artifactPath ? { outputArtifactPath: this.artifactPath } : {}),
    };
  }

  private retainPreview(chunk: string, chunkBytes: number): void {
    if (this.headBytes < TOOL_OUTPUT_HEAD_BYTES) {
      const headPart = takeUtf8Prefix(chunk, TOOL_OUTPUT_HEAD_BYTES - this.headBytes);
      this.head += headPart.text;
      this.headBytes += headPart.bytes;
      const restBytes = chunkBytes - headPart.bytes;
      if (restBytes >= TOOL_OUTPUT_TAIL_BYTES) {
        this.replaceTailWithSuffix(chunk);
      } else if (restBytes > 0) {
        this.appendTail(chunk.slice(headPart.units), restBytes);
      }
      return;
    }
    this.appendTail(chunk, chunkBytes);
  }

  private appendTail(chunk: string, chunkBytes: number): void {
    if (chunkBytes >= TOOL_OUTPUT_TAIL_BYTES) {
      this.replaceTailWithSuffix(chunk);
      return;
    }
    this.tail += chunk;
    this.tailBytes += chunkBytes;
    if (this.tailBytes <= TOOL_OUTPUT_TAIL_BYTES) return;
    const trimmed = takeUtf8Suffix(this.tail, TOOL_OUTPUT_TAIL_BYTES);
    this.tail = trimmed.text;
    this.tailBytes = trimmed.bytes;
  }

  private replaceTailWithSuffix(chunk: string): void {
    const trimmed = takeUtf8Suffix(chunk, TOOL_OUTPUT_TAIL_BYTES);
    this.tail = trimmed.text;
    this.tailBytes = trimmed.bytes;
  }

  private startArtifact(): void {
    this.artifactPath = resolveToolOutputArtifactPath(this.threadId, this.toolCallId);
    NodeFS.mkdirSync(NodePath.dirname(this.artifactPath), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(this.artifactPath, "", { encoding: "utf8", mode: 0o600 });
    this.artifactStarted = true;
  }

  private queueArtifactChunk(chunk: string): void {
    if (!chunk) return;
    this.artifactChunks.push(chunk);
    this.artifactChunkBytes += byteLength(chunk);
    if (this.artifactChunkBytes >= TOOL_OUTPUT_ARTIFACT_FLUSH_BYTES) {
      this.flushArtifactChunks();
    }
  }

  private flushArtifactChunks(): void {
    if (!this.artifactPath || this.artifactChunks.length === 0) return;
    NodeFS.mkdirSync(NodePath.dirname(this.artifactPath), { recursive: true, mode: 0o700 });
    NodeFS.appendFileSync(this.artifactPath, this.artifactChunks.join(""), {
      encoding: "utf8",
      mode: 0o600,
    });
    this.artifactChunks = [];
    this.artifactChunkBytes = 0;
  }

  private previewSoFar(): string {
    return this.head + this.tail;
  }
}

/**
 * Remove stale full-output artifacts and empty directories.
 */
export function pruneStaleToolOutputArtifacts(
  now = Date.now(),
  ttlMs = TOOL_OUTPUT_ARTIFACT_TTL_MS,
): number {
  const root = NodePath.join(getMcodeDir(), "artifacts", "tool-output");
  if (!NodeFS.existsSync(root)) return 0;
  const cutoff = now - ttlMs;
  let removed = 0;

  const walk = (dir: string): boolean => {
    let empty = true;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(path)) {
          NodeFS.rmSync(path, { recursive: true, force: true });
        } else {
          empty = false;
        }
        continue;
      }
      if (!entry.isFile()) {
        empty = false;
        continue;
      }
      const stat = NodeFS.statSync(path);
      if (stat.mtimeMs < cutoff) {
        NodeFS.rmSync(path, { force: true });
        removed++;
      } else {
        empty = false;
      }
    }
    return empty;
  };

  try {
    walk(root);
  } catch (err) {
    logger.warn("Tool-output artifact cleanup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return removed;
}

function safeArtifactSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (/^(?=.*[a-zA-Z0-9])[a-zA-Z0-9._-]{1,160}$/.test(trimmed)) return trimmed;
  const hash = NodeCrypto.createHash("sha256").update(trimmed || fallback).digest("hex").slice(0, 24);
  return `${fallback}-${hash}`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function takeUtf8Prefix(text: string, maxBytes: number): { text: string; bytes: number; units: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0, units: 0 };
  let bytes = 0;
  let units = 0;
  let out = "";
  for (const char of text) {
    const next = byteLength(char);
    if (bytes + next > maxBytes) break;
    out += char;
    bytes += next;
    units += char.length;
  }
  return { text: out, bytes, units };
}

function takeUtf8Suffix(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };
  let bytes = 0;
  let out = "";
  for (let i = text.length; i > 0;) {
    const code = text.charCodeAt(i - 1);
    const width = code >= 0xdc00 && code <= 0xdfff && i > 1 ? 2 : 1;
    const start = i - width;
    const char = text.slice(start, i);
    const next = byteLength(char);
    if (bytes + next > maxBytes) break;
    out = char + out;
    bytes += next;
    i = start;
  }
  return { text: out, bytes };
}
