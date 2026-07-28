import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ThreadControlMutationReservationService } from "../thread-control-mutation-reservation-service.js";

describe("ThreadControlMutationReservationService", () => {
  it("allows one idle claimant and rejects a competing claimant", () => {
    const registry = new ThreadControlMutationReservationService();

    const token = registry.reserve("thread-1", "pendingApproval");

    expect(token).toEqual(expect.any(String));
    expect(registry.reserve("thread-1", "activeTurn")).toBeNull();
    expect(registry.get("thread-1")).toEqual({ token, state: "pendingApproval" });
  });

  it("keeps the token through approval and releases terminal outcomes", () => {
    const registry = new ThreadControlMutationReservationService();
    const token = registry.reserve("thread-1", "pendingApproval")!;

    expect(registry.transition("thread-1", token, "pendingApproval", "activeTurn")).toBe(true);
    expect(registry.owns("thread-1", token, "activeTurn")).toBe(true);
    expect(registry.release("thread-1", token)).toBe(true);
    expect(registry.get("thread-1")).toBeUndefined();
  });

  it("rehydrates a durable pending approval before accepting new work", () => {
    const registry = new ThreadControlMutationReservationService();

    expect(registry.rehydrate("thread-1", "approval-1")).toBe(true);
    expect(registry.reserve("thread-1", "activeTurn")).toBeNull();
    expect(registry.rehydrate("thread-1", "approval-1")).toBe(true);
  });
});
