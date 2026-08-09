import { describe, expect, it } from "vitest";
import {
  resolveTerminalSessionTransition,
  TERMINAL_BOOT_TRANSITIONS,
  TERMINAL_ATTACHMENT_TRANSITIONS,
  TERMINAL_CHECKPOINT_TRANSITIONS,
  TERMINAL_SEQUENCE_TRACES,
  TERMINAL_TOMBSTONE_TRANSITIONS,
} from "../terminal-lifecycle.js";

describe("Terminal v1 lifecycle contract", () => {
  it("allows only frozen session transitions", () => {
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
});
