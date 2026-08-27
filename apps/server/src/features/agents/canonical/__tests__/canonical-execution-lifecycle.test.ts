import { describe, expect, it } from "vitest";
import { decideCanonicalExecutionLifecycle } from "../canonical-execution-lifecycle.js";

describe("decideCanonicalExecutionLifecycle", () => {
  it("accepts the first start and terminal transition", () => {
    expect(decideCanonicalExecutionLifecycle(
      { exists: false, terminalOutcome: null },
      { replayGuard: "execution-started" },
    )).toBe("accept");
    expect(decideCanonicalExecutionLifecycle(
      { exists: true, terminalOutcome: null },
      { terminalOutcome: "completed" },
    )).toBe("accept");
  });

  it("keeps an idempotent duplicate separate from a conflicting terminal signal", () => {
    const state = { exists: true, terminalOutcome: "completed" as const };

    expect(decideCanonicalExecutionLifecycle(state, { terminalOutcome: "completed" })).toBe("duplicate");
    expect(decideCanonicalExecutionLifecycle(state, { terminalOutcome: "errored" })).toBe("conflict");
  });

  it("does not recreate an execution that is already durable", () => {
    expect(decideCanonicalExecutionLifecycle(
      { exists: true, terminalOutcome: null },
      { replayGuard: "execution-started" },
    )).toBe("duplicate");
  });
});
