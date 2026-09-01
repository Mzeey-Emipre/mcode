import { describe, expect, it } from "vitest";
import { MAX_TURN_RECOVERIES, RecoveryIncidentSchema, WS_METHODS } from "../index.js";

describe("turn recovery contracts", () => {
  const incident = {
    id: "00000000-0000-4000-8000-000000000015",
    createdAt: "2026-08-10T09:03:00.000Z",
    entries: [{
      workspaceId: "workspace-1",
      workspaceName: "Workspace",
      threadId: "thread-1",
      threadTitle: "Recovery",
      executionId: "00000000-0000-4000-8000-000000000016",
      startedAt: "2026-08-10T09:00:00.000Z",
      interruptedAt: "2026-08-10T09:03:00.000Z",
      durationMs: 180_000,
    }],
  };

  it("returns one restart-scoped incident or null", () => {
    expect(RecoveryIncidentSchema().parse(incident)).toEqual(incident);
    expect(WS_METHODS()["agent.recoveryIncident"].result.parse(null)).toBeNull();
    expect(WS_METHODS()["agent.recoveryIncident"].result.parse(incident)).toEqual(incident);
    expect(WS_METHODS()["agent.retry"]).toBeDefined();
  });

  it("rejects an entry with a negative duration", () => {
    expect(RecoveryIncidentSchema().safeParse({
      ...incident,
      entries: [{ ...incident.entries[0], durationMs: -1 }],
    }).success).toBe(false);
  });

  it("rejects recovery result overflow", () => {
    expect(WS_METHODS()["agent.recoveryIncident"].result.safeParse({
      ...incident,
      entries: Array.from({ length: MAX_TURN_RECOVERIES + 1 }, () => incident.entries[0]),
    }).success).toBe(false);
  });
});
