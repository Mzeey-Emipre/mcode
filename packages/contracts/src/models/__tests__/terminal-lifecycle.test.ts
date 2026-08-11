import { describe, expect, it } from "vitest";
import {
  executeTerminalSequenceTrace,
  executeTerminalTransitionTrace,
  resolveTerminalSessionTransition,
  TERMINAL_BOOT_TRANSITIONS,
  TERMINAL_ATTACHMENT_TRANSITIONS,
  TERMINAL_CHECKPOINT_TRANSITIONS,
  TERMINAL_HYDRATION_DECISIONS,
  TERMINAL_SEQUENCE_TRACES,
  TERMINAL_TOMBSTONE_TRANSITIONS,
} from "../terminal-lifecycle.js";

describe("Terminal v1 lifecycle contract", () => {
  it("allows only frozen session transitions", () => {
    expect(Object.isFrozen(TERMINAL_BOOT_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(TERMINAL_BOOT_TRANSITIONS[0])).toBe(true);
    expect(Object.isFrozen(TERMINAL_SEQUENCE_TRACES)).toBe(true);
    expect(Object.isFrozen(TERMINAL_SEQUENCE_TRACES.create)).toBe(true);
    expect(resolveTerminalSessionTransition(null, "create-accepted")).toBe("starting");
    expect(resolveTerminalSessionTransition("running", "close-requested")).toBe("exiting");
    expect(resolveTerminalSessionTransition("exited", "explicit-close")).toBeNull();
    expect(() => resolveTerminalSessionTransition("exited", "input-accepted")).toThrow(
      /transition/i,
    );
  });

  it("never switches a live modern boot to legacy after a host crash", () => {
    expect(
      TERMINAL_BOOT_TRANSITIONS.find(
        (transition) =>
          transition.from === "modern-selected" && transition.event === "host-unhealthy",
      ),
    ).toMatchObject({ to: "modern-recovering" });
  });

  it("aborts incomplete checkpoint uploads and requires reattachment", () => {
    expect(
      TERMINAL_CHECKPOINT_TRANSITIONS.find(
        (transition) => transition.from === "open" && transition.event === "missing-chunk",
      ),
    ).toMatchObject({ to: "aborted", retry: "REATTACH" });
    expect(TERMINAL_SEQUENCE_TRACES.hide).toContain("checkpoint.complete-authority");
    expect(TERMINAL_SEQUENCE_TRACES.hide).not.toContain("checkpoint.chunk-ack");
  });

  it("revokes stalled attachments before retrying", () => {
    expect(
      TERMINAL_ATTACHMENT_TRANSITIONS.find(
        (transition) => transition.from === "attached" && transition.event === "ack-stalled",
      ),
    ).toMatchObject({ to: null, retry: "REATTACH" });
  });

  it("keeps a tombstone when replacement fails", () => {
    expect(
      TERMINAL_TOMBSTONE_TRANSITIONS.find(
        (transition) =>
          transition.from === "replacement-starting" &&
          transition.event === "replacement-failed",
      ),
    ).toMatchObject({ to: "retained", retry: "NEW_SESSION" });
    expect(TERMINAL_SEQUENCE_TRACES.headlessClose).toContain("tombstone");
  });

  it("executes complete frozen traces and rejects forbidden events", () => {
    expect(
      executeTerminalTransitionTrace(TERMINAL_BOOT_TRANSITIONS, "starting", [
        "modern-ready",
        "host-unhealthy",
        "replacement-ready",
        "shutdown",
      ]),
    ).toEqual(["modern-selected", "modern-recovering", "modern-selected", "stopped"]);

    expect(
      executeTerminalTransitionTrace(TERMINAL_CHECKPOINT_TRANSITIONS, null, [
        "begin-validated",
        "chunk-accepted",
        "missing-chunk",
      ]),
    ).toEqual(["open", "open", "aborted"]);

    expect(() =>
      executeTerminalTransitionTrace(TERMINAL_ATTACHMENT_TRANSITIONS, null, [
        "attach-validated",
        "detach",
      ]),
    ).toThrow(/transition/i);

    expect(() =>
      executeTerminalTransitionTrace(
        TERMINAL_BOOT_TRANSITIONS,
        "starting",
        Array.from({ length: 257 }, () => "create-requested" as const),
      ),
    ).toThrow(/256/);
  });

  it("executes every normative actor trace in frozen order", () => {
    for (const traceName of Object.keys(TERMINAL_SEQUENCE_TRACES) as Array<
      keyof typeof TERMINAL_SEQUENCE_TRACES
    >) {
      const visited = executeTerminalSequenceTrace(traceName, (action, index) => ({
        action,
        index,
      }));

      expect(visited).toEqual(
        TERMINAL_SEQUENCE_TRACES[traceName].map((action, index) => ({ action, index })),
      );
    }
  });

  it("executes checkpoint installation and preserves each reconnect decision", () => {
    expect(
      executeTerminalTransitionTrace(TERMINAL_CHECKPOINT_TRANSITIONS, null, [
        "begin-validated",
        "chunk-accepted",
        "complete-valid",
      ]),
    ).toEqual(["open", "open", "installed"]);
    expect(TERMINAL_HYDRATION_DECISIONS).toEqual([
      { condition: "requested-output-contiguous", mode: "delta", retry: null },
      {
        condition: "checkpoint-valid-and-tail-contiguous",
        mode: "checkpoint-delta",
        retry: null,
      },
      {
        condition: "retention-or-checkpoint-gap",
        mode: "reset-tail-gap",
        retry: "REATTACH",
      },
      { condition: "host-generation-mismatch", mode: null, retry: "NEW_SESSION" },
    ]);
  });
});
