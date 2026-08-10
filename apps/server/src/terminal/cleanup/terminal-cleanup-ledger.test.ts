import { describe, expect, it } from "vitest";
import { PtyHostCleanupLedger } from "./terminal-cleanup-ledger.js";

describe("PtyHostCleanupLedger", () => {
  it("bounds records, isolates generations, and removes exited sessions", () => {
    const ledger = new PtyHostCleanupLedger(2);
    ledger.record({
      sessionId: "a",
      hostGeneration: "1",
      rootPid: 101,
      processGroupId: "job-a",
    });
    ledger.record({
      sessionId: "b",
      hostGeneration: "2",
      rootPid: 102,
      processGroupId: "job-b",
    });

    expect(ledger.forGeneration("1")).toEqual([
      {
        sessionId: "a",
        hostGeneration: "1",
        rootPid: 101,
        processGroupId: "job-a",
      },
    ]);
    expect(() =>
      ledger.record({
        sessionId: "c",
        hostGeneration: "2",
        rootPid: 103,
        processGroupId: "job-c",
      }),
    ).toThrow(/limit/i);

    ledger.remove("a");
    expect(ledger.forGeneration("1")).toEqual([]);
  });
});
