import { describe, it, expect } from "vitest";
import { getStatusDisplay, getNotificationDot } from "@/lib/thread-status";
import type { Thread } from "@/transport/types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    workspace_id: "ws1",
    title: "Test",
    status: "active",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    worktree_managed: false,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    provider: "claude",
    deleted_at: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    permission_mode: null,
    copilot_agent: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    ...overrides,
  };
}

describe("getStatusDisplay", () => {
  it("isActuallyRunning=true returns no label and pulsing primary dot", () => {
    const result = getStatusDisplay(makeThread(), true);
    expect(result.label).toBe("");
    expect(result.color).toContain("primary");
    expect(result.dotClass).toContain("bg-primary");
    expect(result.dotClass).toContain("animate-pulse");
  });

  it("errored status returns Errored with diff-remove-strong color", () => {
    const result = getStatusDisplay(makeThread({ status: "errored" }), false);
    expect(result.label).toBe("Errored");
    expect(result.color).toContain("--diff-remove-strong");
  });

  it("completed status returns no label with diff-add-strong dot", () => {
    const result = getStatusDisplay(makeThread({ status: "completed" }), false);
    expect(result.label).toBe("");
    expect(result.dotClass).toContain("--diff-add-strong");
  });

  it("default status returns empty label", () => {
    const result = getStatusDisplay(makeThread({ status: "active" }), false);
    expect(result.label).toBe("");
  });

  it("shows amber pulsing dot when thread has a pending permission and is running", () => {
    const result = getStatusDisplay(makeThread(), true, true);
    expect(result.dotClass).toBe("bg-amber-500 animate-pulse");
    expect(result.color).toBe("text-amber-500");
  });

  it("shows amber dot when thread has pending permission even if not running", () => {
    const result = getStatusDisplay(makeThread({ status: "active" }), false, true);
    expect(result.dotClass).toContain("amber");
  });
});

describe("getNotificationDot", () => {
  it("returns primary with pulse for running thread", () => {
    const result = getNotificationDot(makeThread(), true);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toContain("bg-primary");
    expect(result!.animate).toBe(true);
  });

  it("returns diff-add-strong for completed thread", () => {
    const result = getNotificationDot(makeThread({ status: "completed" }), false);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toContain("--diff-add-strong");
    expect(result!.animate).toBe(false);
  });

  it("returns diff-remove-strong for errored thread", () => {
    const result = getNotificationDot(makeThread({ status: "errored" }), false);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toContain("--diff-remove-strong");
    expect(result!.animate).toBe(false);
  });

  it("returns null for idle thread", () => {
    const result = getNotificationDot(makeThread({ status: "active" }), false);
    expect(result).toBeNull();
  });

  it("returns null for paused thread", () => {
    const result = getNotificationDot(makeThread({ status: "paused" }), false);
    expect(result).toBeNull();
  });

  it("returns amber dot when thread has pending permission and is running", () => {
    const result = getNotificationDot(makeThread(), true, true);
    expect(result).not.toBeNull();
    expect(result!.dotClass).toBe("bg-amber-500");
    expect(result!.animate).toBe(true);
  });
});
