import { describe, expect, it } from "vitest";
import {
  WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES,
  WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES,
  WorkspaceEnvironmentCommandSchema,
  WorkspaceEnvironmentDocumentSchema,
  WorkspaceEnvironmentSetupAttemptSchema,
  workspaceEnvironmentValidationIssues,
} from "../workspace-environment.js";

const validCommand = { default: "bun run dev" };
const validDocument = {
  version: "0.0.1",
  setup: validCommand,
  actions: [{ id: "opaque-id", name: "Run app", command: validCommand }],
};

describe("workspace environment contracts", () => {
  it("accepts the exact versioned document shape and preserves action ids", () => {
    const result = WorkspaceEnvironmentDocumentSchema().parse(validDocument);
    expect(result).toEqual(validDocument);
    expect(result.actions[0]?.id).toBe("opaque-id");
  });

  it("rejects missing scripts, byte-boundary overflow, null bytes, and unknown keys", () => {
    expect(WorkspaceEnvironmentCommandSchema().safeParse({}).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "x".repeat(WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES + 1) }).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "é".repeat(Math.floor(WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES / 2) + 1) }).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "ok\0bad" }).success).toBe(false);
    expect(WorkspaceEnvironmentCommandSchema().safeParse({ default: "ok", extra: "no" }).success).toBe(false);
    expect(WorkspaceEnvironmentDocumentSchema().safeParse({ ...validDocument, extra: true }).success).toBe(false);
    expect(WorkspaceEnvironmentDocumentSchema().safeParse({ ...validDocument, actions: [{ ...validDocument.actions[0], extra: true }] }).success).toBe(false);
  });

  it("returns stable structured reasons for unsupported versions and size limits", () => {
    const version = WorkspaceEnvironmentDocumentSchema().safeParse({ ...validDocument, version: "9.9.9" });
    expect(version.success).toBe(false);
    if (!version.success) {
      expect(workspaceEnvironmentValidationIssues(version.error)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["version"], code: "UNSUPPORTED_VERSION", reason: "unsupported_version" }),
      ]));
    }

    const command = WorkspaceEnvironmentCommandSchema().safeParse({ default: "x".repeat(32_760), windows: "x".repeat(32_760) });
    expect(command.success).toBe(false);
    if (!command.success) {
      expect(workspaceEnvironmentValidationIssues(command.error)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "COMMAND_TOO_LARGE", reason: "command_too_large" }),
      ]));
    }
    expect(WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES).toBe(64 * 1024);
  });

  it("rejects duplicate action ids with a path to the duplicate", () => {
    const result = WorkspaceEnvironmentDocumentSchema().safeParse({
      ...validDocument,
      actions: [validDocument.actions[0], { ...validDocument.actions[0], name: "Run again" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(workspaceEnvironmentValidationIssues(result.error)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["actions", 1, "id"],
          code: "DUPLICATE_ACTION_ID",
          reason: "duplicate_action_id",
        }),
      ]));
    }
  });

  it("preserves a nonblank default when an OS override is blank", () => {
    const command = WorkspaceEnvironmentCommandSchema().parse({
      default: "  bun run setup  ",
      windows: " \t ",
    });

    expect(command).toEqual({ default: "  bun run setup  ", windows: " \t " });
  });

  it("carries Terminal-bounded immutable manual Setup outcomes without environment values", () => {
    const attempt = WorkspaceEnvironmentSetupAttemptSchema().parse({
      id: "attempt-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      status: "failed",
      outcome: "containment_failure",
      snapshot: {
        platform: "windows",
        script: "bun run setup",
        checkoutPath: "C:\\repo",
        terminal: {
          executable: "C:\\Program Files\\PowerShell\\pwsh.exe",
          arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "bun run setup"],
        },
      },
      createdAt: "2026-08-22T12:00:00.000Z",
      startedAt: "2026-08-22T12:00:00.000Z",
      finishedAt: "2026-08-22T12:00:05.000Z",
      exitCode: null,
      output: "Setup timed out",
      outputTruncated: false,
      cleanupPending: true,
    });

    expect(attempt.outcome).toBe("containment_failure");
    expect(attempt.snapshot.terminal?.arguments).toContain("-NonInteractive");
    expect(JSON.stringify(attempt)).not.toContain("SECRET_TOKEN");
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      cleanupPending: false,
      snapshot: {
        ...attempt.snapshot,
        terminal: {
          executable: "x".repeat(1_025),
          arguments: Array.from({ length: 33 }, () => "argument"),
        },
      },
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "running",
      outcome: null,
      startedAt: null,
      finishedAt: null,
      cleanupPending: false,
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "passed",
      outcome: "success",
      cleanupPending: false,
      exitCode: 1,
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "passed",
      outcome: "success",
      cleanupPending: false,
      exitCode: 0,
      startedAt: null,
    }).success).toBe(false);
    expect(WorkspaceEnvironmentSetupAttemptSchema().safeParse({
      ...attempt,
      status: "failed",
      outcome: "success",
      cleanupPending: false,
      exitCode: 0,
    }).success).toBe(false);
  });
});
