import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  BoundedToolOutputBuffer,
  TOOL_OUTPUT_PREVIEW_BYTES,
  boundToolOutput,
  pruneStaleToolOutputArtifacts,
  resolveToolOutputArtifactPath,
} from "@mcode/providers";

describe("bounded tool output", () => {
  let originalDataDir: string | undefined;
  let testDataDir: string;

  beforeAll(() => {
    originalDataDir = process.env.MCODE_DATA_DIR;
    testDataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-bounded-output-"));
    process.env.MCODE_DATA_DIR = testDataDir;
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.MCODE_DATA_DIR;
    } else {
      process.env.MCODE_DATA_DIR = originalDataDir;
    }
    NodeFS.rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    NodeFS.rmSync(NodePath.join(testDataDir, "artifacts", "tool-output"), {
      recursive: true,
      force: true,
    });
  });

  it("keeps small output inline without an artifact reference", () => {
    const result = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "tool-1",
      output: "hello",
    });

    expect(result).toEqual({
      output: "hello",
      outputTruncated: false,
      outputTotalBytes: 5,
    });
  });

  it("keeps head and tail preview while spooling the full output", () => {
    const fullOutput =
      "A".repeat(200 * 1024)
      + "M".repeat(16 * 1024)
      + "Z".repeat(80 * 1024);
    const result = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "tool-1",
      output: fullOutput,
    });

    expect(result.outputTruncated).toBe(true);
    expect(result.outputTotalBytes).toBe(Buffer.byteLength(fullOutput, "utf8"));
    expect(Buffer.byteLength(result.output, "utf8")).toBe(TOOL_OUTPUT_PREVIEW_BYTES);
    expect(result.output.startsWith("A".repeat(1024))).toBe(true);
    expect(result.output.endsWith("Z".repeat(1024))).toBe(true);
    expect(NodeFS.readFileSync(result.outputArtifactPath!, "utf8")).toBe(fullOutput);
  });

  it("sanitizes artifact path segments", () => {
    const path = resolveToolOutputArtifactPath("../thread", "../tool");
    const dotPath = resolveToolOutputArtifactPath("..", ".");

    expect(path).toContain(NodePath.join("artifacts", "tool-output"));
    expect(path).not.toContain("..");
    expect(dotPath).toContain(NodePath.join("artifacts", "tool-output"));
    expect(NodePath.basename(NodePath.dirname(dotPath))).toMatch(/^thread-[a-f0-9]{24}$/);
    expect(NodePath.basename(dotPath)).toMatch(/^tool-[a-f0-9]{24}\.txt$/);
  });

  it("drops forced artifacts for small untruncated output", () => {
    const result = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "tool-1",
      output: "small",
      forceArtifact: true,
    });

    expect(result).toEqual({
      output: "small",
      outputTruncated: false,
      outputTotalBytes: 5,
    });
  });

  it("retains only the tail when a single chunk exceeds the tail budget", () => {
    const buffer = new BoundedToolOutputBuffer("thread-1", "tool-1");
    const fullOutput =
      "A".repeat(200 * 1024)
      + "M".repeat(16 * 1024)
      + "Z".repeat(80 * 1024);

    buffer.append(fullOutput);
    const result = buffer.finalize();

    expect(result.outputTruncated).toBe(true);
    expect(result.output.endsWith("Z".repeat(64 * 1024))).toBe(true);
    expect(result.output.includes("M".repeat(1024))).toBe(false);
  });

  it("recreates the artifact directory before flushing queued chunks", () => {
    const buffer = new BoundedToolOutputBuffer("thread-1", "tool-1", {
      forceArtifact: true,
    });
    const artifactPath = resolveToolOutputArtifactPath("thread-1", "tool-1");
    const largeOutput = "x".repeat(300 * 1024);

    buffer.append("small");
    NodeFS.rmSync(NodePath.dirname(artifactPath), { recursive: true, force: true });
    buffer.append(largeOutput);
    const result = buffer.finalize();

    expect(NodeFS.readFileSync(result.outputArtifactPath!, "utf8")).toBe(`small${largeOutput}`);
  });

  it("prunes stale artifacts and keeps fresh artifacts", () => {
    const stale = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "old",
      output: "x".repeat(300 * 1024),
    });
    const fresh = boundToolOutput({
      threadId: "thread-1",
      toolCallId: "new",
      output: "y".repeat(300 * 1024),
    });
    const oldTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    NodeFS.utimesSync(stale.outputArtifactPath!, oldTime, oldTime);

    const removed = pruneStaleToolOutputArtifacts();

    expect(removed).toBe(1);
    expect(NodeFS.existsSync(stale.outputArtifactPath!)).toBe(false);
    expect(NodeFS.existsSync(fresh.outputArtifactPath!)).toBe(true);
    expect(NodeFS.statSync(fresh.outputArtifactPath!).isFile()).toBe(true);
  });
});
