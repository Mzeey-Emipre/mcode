import { describe, expect, it } from "vitest";
import {
  TerminalAttachmentDescriptorSchema,
  TerminalErrorSchema,
  TerminalHydrationDescriptorSchema,
  TerminalSessionSnapshotSchema,
  TerminalScopeSchema,
  TerminalU64Schema,
  TerminalUuidSchema,
} from "../terminal.js";

const UUID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";

describe("Terminal v1 models", () => {
  it("accepts canonical identifiers and rejects ambiguous boundary encodings", () => {
    expect(TerminalUuidSchema().parse(UUID)).toBe(UUID);
    expect(TerminalU64Schema().parse("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    for (const value of ["01", "+1", "1.0", "1e3", "18446744073709551616"]) {
      expect(() => TerminalU64Schema().parse(value)).toThrow();
    }
    expect(TerminalU64Schema().safeParse("not-u64").success).toBe(false);
    expect(() => TerminalUuidSchema().parse(UUID.toUpperCase())).toThrow();
  });

  it("validates workspace and thread scopes strictly", () => {
    expect(
      TerminalScopeSchema().parse({ kind: "thread", workspaceId: UUID, threadId: UUID }),
    ).toEqual({ kind: "thread", workspaceId: UUID, threadId: UUID });
    expect(() =>
      TerminalScopeSchema().parse({ kind: "workspace", workspaceId: UUID, threadId: UUID }),
    ).toThrow();
  });

  it("rejects snapshots whose exit and tombstone fields contradict lifecycle state", () => {
    const running = {
      contractVersion: 1,
      sessionId: UUID,
      scope: { kind: "workspace", workspaceId: UUID },
      state: "running",
      hostGeneration: "1",
      launch: {
        requestedProfileId: "automatic",
        resolvedProfile: {
          id: "certified:windows-powershell-7",
          name: "PowerShell 7",
          executable: "pwsh.exe",
          arguments: [],
          source: "certified",
          platform: "windows",
        },
        scope: { kind: "workspace", workspaceId: UUID },
        arguments: [],
      },
      createdAt: "2026-08-09T12:00:00.000Z",
      lastCommandSeq: "0",
      lastOutputSeq: "0",
      exit: null,
      tombstone: false,
    } as const;
    expect(TerminalSessionSnapshotSchema().parse(running)).toEqual(running);
    expect(() =>
      TerminalSessionSnapshotSchema().parse({ ...running, tombstone: true }),
    ).toThrow();
    expect(() =>
      TerminalSessionSnapshotSchema().parse({ ...running, state: "exited" }),
    ).toThrow();
    expect(() =>
      TerminalSessionSnapshotSchema().parse({
        ...running,
        launch: {
          ...running.launch,
          scope: { kind: "workspace", workspaceId: "12345678-abcd-4abc-8abc-abcdefabcdef" },
        },
      }),
    ).toThrow();
  });

  it("keeps attachment input disabled until hydration completes", () => {
    const descriptor = {
      contractVersion: 1,
      sessionId: UUID,
      attachmentId: UUID,
      attachmentEpoch: "1",
      hostGeneration: "1",
      hydrationId: UUID,
      inputEnabled: false,
      serverHighBytes: 1_048_576,
      serverLowBytes: 262_144,
      clientHighBytes: 262_144,
      clientLowBytes: 65_536,
    } as const;
    expect(TerminalAttachmentDescriptorSchema().parse(descriptor)).toEqual(descriptor);
    expect(() =>
      TerminalAttachmentDescriptorSchema().parse({ ...descriptor, inputEnabled: true }),
    ).toThrow();
  });

  it("rejects reversed hydration output ranges", () => {
    expect(() =>
      TerminalHydrationDescriptorSchema().parse({
        hydrationId: UUID,
        mode: "delta",
        requestedAfterSeq: "0",
        checkpointThroughSeq: null,
        firstOutputSeq: "2",
        lastOutputSeq: "1",
        gap: null,
        chunkCount: 1,
        totalBytes: 1,
      }),
    ).toThrow(/reversed/i);
  });

  it("rejects messages and correlation IDs that exceed the public error bounds", () => {
    expect(() =>
      TerminalErrorSchema().parse({
        code: "HOST_UNHEALTHY",
        message: "x".repeat(513),
        retry: "RESTART",
        correlationId: "c",
      }),
    ).toThrow();
    expect(() =>
      TerminalErrorSchema().parse({
        code: "HOST_UNHEALTHY",
        message: "Host unavailable",
        retry: "RESTART",
        correlationId: "x".repeat(65),
      }),
    ).toThrow();
  });
});
