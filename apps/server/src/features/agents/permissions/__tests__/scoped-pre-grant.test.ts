import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { ScopedPreGrantService } from "../scoped-pre-grant";

const T = "child-thread-1";
const DOC = resolve("/tmp/mcode-handoff-child-thread-1-123.md");
const OTHER = resolve("/tmp/secrets.env");

describe("ScopedPreGrantService", () => {
  let svc: ScopedPreGrantService;
  beforeEach(() => {
    svc = new ScopedPreGrantService();
    svc.issue({ threadId: T, toolName: "Read", path: DOC });
  });

  it("path-scoped: grants the exact path, denies any other path", () => {
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: OTHER })).toBe(false);
    // a sibling/parent dir is NOT covered (no prefix matching)
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: resolve("/tmp") })).toBe(false);
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: DOC })).toBe(true);
  });

  it("path-scoped: matches across separator/././ normalisation", () => {
    const messy = "/tmp/./sub/../mcode-handoff-child-thread-1-123.md";
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: messy })).toBe(true);
  });

  it("tool-scoped: a different tool on the same path is not pre-granted", () => {
    expect(svc.tryConsume({ threadId: T, toolName: "Edit", path: DOC })).toBe(false);
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: DOC })).toBe(true);
  });

  it("one-shot: a second Read of the same path on the same Turn is not pre-granted", () => {
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: DOC })).toBe(true);
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: DOC })).toBe(false);
  });

  it("thread-scoped: a different thread's Read is not pre-granted", () => {
    expect(svc.tryConsume({ threadId: "other-thread", toolName: "Read", path: DOC })).toBe(false);
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: DOC })).toBe(true);
  });

  it("turn-scoped: clear() drops the grant so it does not survive into the next Turn", () => {
    expect(svc.hasActiveGrant(T)).toBe(true);
    svc.clear(T);
    expect(svc.hasActiveGrant(T)).toBe(false);
    expect(svc.tryConsume({ threadId: T, toolName: "Read", path: DOC })).toBe(false);
  });
});
