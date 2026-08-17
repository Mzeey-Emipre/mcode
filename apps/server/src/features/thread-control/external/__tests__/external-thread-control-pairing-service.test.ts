import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  ExternalThreadControlPairingError,
  ExternalThreadControlPairingService,
  type ExternalThreadControlAuthenticatedPairing,
  type ExternalThreadControlPairingInput,
} from "../external-thread-control-pairing-service.js";

interface FakePairingRow {
  pairing_id: string;
  integration_id: string;
  credential_hash: string;
  workspace_ids_json: string;
  scopes_json: string;
  calls_per_minute: number;
  max_active_threads: number;
  status: "active" | "revoked";
  authority_epoch: number;
  created_at: string;
  updated_at: string;
  replaced_by_pairing_id: string | null;
  replaces_pairing_id: string | null;
}

interface FakeDeliveryRow {
  pairing_id: string;
  authority_epoch: number;
  delivery_id: string;
  fingerprint: string;
  status: "in_flight" | "terminal";
  result_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface FakeApprovalRow {
  caller_id: string;
  status: "pending" | "processing" | "failed";
}

interface FakeDbState {
  pairings: FakePairingRow[];
  deliveries: FakeDeliveryRow[];
  approvals: FakeApprovalRow[];
}

function createFakeDb(): FakeDbState & {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => { changes: number } };
  transaction: <T>(callback: () => T) => () => T;
} {
  const state: FakeDbState = { pairings: [], deliveries: [], approvals: [] };
  const db = {
    pairings: state.pairings,
    deliveries: state.deliveries,
    approvals: state.approvals,
    prepare(sql: string) {
      const statement = sql.trimStart();
      return {
        get(...args: unknown[]) {
          if (statement.includes("external_thread_control_deliveries") && statement.includes("delivery_id = ?")) {
            const row = state.deliveries.find((delivery) =>
              delivery.pairing_id === args[0] && delivery.authority_epoch === args[1] && delivery.delivery_id === args[2]);
            return row;
          }
          if (statement.includes("COUNT(*) AS count") && statement.includes("created_at > ?")) {
            const [integrationId, cutoff] = args as [string, string];
            return { count: state.deliveries.filter((delivery) => {
              const pairing = state.pairings.find((candidate) => candidate.pairing_id === delivery.pairing_id);
              return pairing?.integration_id === integrationId && delivery.created_at > cutoff;
            }).length };
          }
          if (statement.includes("COUNT(*) AS count")) {
            const [integrationId] = args as [string];
            return { count: state.deliveries.filter((delivery) =>
              state.pairings.find((pairing) => pairing.pairing_id === delivery.pairing_id)?.integration_id === integrationId).length };
          }
          if (statement.includes("ORDER BY d.updated_at ASC")) {
            const [integrationId] = args as [string];
            return state.deliveries
              .filter((delivery) => delivery.status === "terminal"
                && state.pairings.find((pairing) => pairing.pairing_id === delivery.pairing_id)?.integration_id === integrationId)
              .sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];
          }
          if (statement.includes("integration_id = ?") && statement.includes("status = 'active'")) {
            const [integrationId] = args as [string];
            const row = state.pairings.find((pairing) => pairing.integration_id === integrationId && pairing.status === "active");
            return row ? { pairing_id: row.pairing_id } : undefined;
          }
          if (statement.includes("credential_hash = ?")) {
            return state.pairings.find((pairing) => pairing.credential_hash === args[0]);
          }
          if (statement.includes("external_thread_control_pairings") && statement.includes("pairing_id = ?")) {
            return state.pairings.find((pairing) => pairing.pairing_id === args[0]);
          }
          throw new Error(`Unsupported fake get query: ${statement}`);
        },
        run(...args: unknown[]) {
          if (statement.startsWith("INSERT INTO external_thread_control_pairings")) {
            if (args.length === 9) {
              state.pairings.push({
                pairing_id: String(args[0]), integration_id: String(args[1]), credential_hash: String(args[2]),
                workspace_ids_json: String(args[3]), scopes_json: String(args[4]), calls_per_minute: Number(args[5]),
                max_active_threads: Number(args[6]), status: "active", authority_epoch: 1,
                created_at: String(args[7]), updated_at: String(args[8]), replaced_by_pairing_id: null, replaces_pairing_id: null,
              });
            } else {
              state.pairings.push({
                pairing_id: String(args[0]), integration_id: String(args[1]), credential_hash: String(args[2]),
                workspace_ids_json: String(args[3]), scopes_json: String(args[4]), calls_per_minute: Number(args[5]),
                max_active_threads: Number(args[6]), status: "active", authority_epoch: Number(args[7]),
                created_at: String(args[8]), updated_at: String(args[9]), replaced_by_pairing_id: null, replaces_pairing_id: String(args[10]),
              });
            }
            return { changes: 1 };
          }
          if (statement.startsWith("UPDATE external_thread_control_pairings")) {
            const replacing = statement.includes("replaced_by_pairing_id");
            const pairingId = String(args[replacing ? 2 : 1]);
            const row = state.pairings.find((pairing) => pairing.pairing_id === pairingId && pairing.status === "active");
            if (!row) return { changes: 0 };
            row.status = "revoked";
            row.updated_at = String(args[1] ?? args[0]);
            if (replacing) row.replaced_by_pairing_id = String(args[0]);
            return { changes: 1 };
          }
          if (statement.startsWith("UPDATE thread_control_approvals")) {
            const callerId = String(args[1]);
            let changes = 0;
            for (const approval of state.approvals) {
              if (approval.caller_id === callerId && (approval.status === "pending" || approval.status === "processing")) {
                approval.status = "failed";
                changes += 1;
              }
            }
            return { changes };
          }
          if (statement.startsWith("DELETE FROM external_thread_control_deliveries WHERE status = 'terminal'")) {
            const cutoff = String(args[0]);
            const before = state.deliveries.length;
            state.deliveries.splice(0, state.deliveries.length, ...state.deliveries.filter((delivery) => !(delivery.status === "terminal" && delivery.expires_at <= cutoff)));
            return { changes: before - state.deliveries.length };
          }
          if (statement.startsWith("UPDATE external_thread_control_deliveries")) {
            if (args.length === 5) {
              const [resultJson, updatedAt, pairingId, epoch, deliveryId] = args as [string, string, string, number, string];
              const delivery = state.deliveries.find((candidate) => candidate.pairing_id === pairingId
                && candidate.authority_epoch === epoch && candidate.delivery_id === deliveryId && candidate.status === "in_flight");
              if (!delivery) return { changes: 0 };
              delivery.status = "terminal";
              delivery.result_json = resultJson;
              delivery.updated_at = updatedAt;
              return { changes: 1 };
            }
            const [resultJson, updatedAt, expiresAt] = args as [string, string, string];
            let changes = 0;
            for (const delivery of state.deliveries) {
              if (delivery.status !== "in_flight" || delivery.expires_at > expiresAt) continue;
              delivery.status = "terminal";
              delivery.result_json = resultJson;
              delivery.updated_at = updatedAt;
              changes += 1;
            }
            return { changes };
          }
          if (statement.startsWith("DELETE FROM external_thread_control_deliveries WHERE pairing_id")) {
            const [pairingId, epoch, deliveryId] = args as [string, number, string];
            const before = state.deliveries.length;
            state.deliveries.splice(0, state.deliveries.length, ...state.deliveries.filter((delivery) => !(delivery.pairing_id === pairingId
              && delivery.authority_epoch === epoch && delivery.delivery_id === deliveryId && delivery.status === "terminal")));
            return { changes: before - state.deliveries.length };
          }
          if (statement.startsWith("INSERT INTO external_thread_control_deliveries")) {
            state.deliveries.push({
              pairing_id: String(args[0]), authority_epoch: Number(args[1]), delivery_id: String(args[2]), fingerprint: String(args[3]),
              status: "in_flight", result_json: null, created_at: String(args[4]), updated_at: String(args[5]), expires_at: String(args[6]),
            });
            return { changes: 1 };
          }
          throw new Error(`Unsupported fake run query: ${statement}`);
        },
      };
    },
    transaction<T>(callback: () => T) {
      return () => callback();
    },
  };
  return db;
}

const input = (overrides: Partial<ExternalThreadControlPairingInput> = {}): ExternalThreadControlPairingInput => ({
  integrationId: "integration-1",
  workspaceIds: ["workspace-1"],
  scopes: ["threads:read-project"],
  callsPerMinute: 10,
  maxActiveThreads: 2,
  ...overrides,
});

function authenticate(service: ExternalThreadControlPairingService, secret: string): ExternalThreadControlAuthenticatedPairing {
  return service.authenticate(secret);
}

describe("external thread-control pairing service", () => {
  it("rejects a second active pairing for one integration", () => {
    const db = createFakeDb();
    const service = new ExternalThreadControlPairingService(db as unknown as Database.Database);
    const pairing = service.create(input());
    expect(() => service.create(input())).toThrowError(new ExternalThreadControlPairingError("conflict", "External integration already has an active pairing"));
    expect(() => service.replace(pairing.pairingId, input({ integrationId: "integration-2" }))).toThrowError("Pairing replacement must preserve integration identity");
  });

  it("does not let an old revoke cancel successor approvals", () => {
    const db = createFakeDb();
    const service = new ExternalThreadControlPairingService(db as unknown as Database.Database);
    const old = service.create(input());
    const successor = service.replace(old.pairingId, input());
    db.approvals.push({ caller_id: "integration-1", status: "pending" });
    expect(service.revoke(old.pairingId).status).toBe("revoked");
    expect(service.findById(successor.pairingId)?.status).toBe("active");
    expect(db.approvals[0]?.status).toBe("pending");
  });

  it("keeps rate reservations durable across service instances and free of duplicate charge", () => {
    const db = createFakeDb();
    const firstService = new ExternalThreadControlPairingService(db as unknown as Database.Database);
    const secret = firstService.create(input({ callsPerMinute: 1 }));
    const authority = authenticate(firstService, secret.credential);
    expect(firstService.beginDelivery(authority, "delivery-1", "fingerprint").status).toBe("reserved");
    const secondService = new ExternalThreadControlPairingService(db as unknown as Database.Database);
    expect(secondService.beginDelivery(authority, "delivery-1", "fingerprint").status).toBe("joined");
    expect(() => secondService.beginDelivery(authority, "delivery-2", "fingerprint")).toThrowError("External call rate limit exceeded");
  });

  it("rejects a new delivery when all 10,000 retained slots are in flight", () => {
    const db = createFakeDb();
    const service = new ExternalThreadControlPairingService(db as unknown as Database.Database);
    const secret = service.create(input());
    const authority = authenticate(service, secret.credential);
    const retainedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (let index = 0; index < 10_000; index += 1) {
      db.deliveries.push({
        pairing_id: authority.pairing.pairingId, authority_epoch: authority.pairing.authorityEpoch, delivery_id: `delivery-${index}`,
        fingerprint: "fingerprint", status: "in_flight", result_json: null,
        created_at: "2026-07-29T00:00:00.000Z", updated_at: "2026-07-29T00:00:00.000Z", expires_at: retainedUntil,
      });
    }
    expect(() => service.beginDelivery(authority, "delivery-new", "fingerprint")).toThrowError("External replay retention is full");
  });

  it("terminalizes expired in-flight rows before capacity accounting and preserves replay", () => {
    const db = createFakeDb();
    const service = new ExternalThreadControlPairingService(db as unknown as Database.Database);
    const secret = service.create(input());
    const authority = authenticate(service, secret.credential);
    const expired = {
      pairing_id: authority.pairing.pairingId, authority_epoch: authority.pairing.authorityEpoch, delivery_id: "expired",
      fingerprint: "fingerprint", status: "in_flight" as const, result_json: null,
      created_at: "2026-07-28T00:00:00.000Z", updated_at: "2026-07-28T00:00:00.000Z", expires_at: "2026-07-29T00:00:00.000Z",
    };
    db.deliveries.push(expired);
    for (let index = 0; index < 9_999; index += 1) {
      db.deliveries.push({
        pairing_id: authority.pairing.pairingId, authority_epoch: authority.pairing.authorityEpoch, delivery_id: `delivery-${index}`,
        fingerprint: "fingerprint", status: "in_flight", result_json: null,
        created_at: "2026-07-29T00:00:00.000Z", updated_at: "2026-07-29T00:00:00.000Z", expires_at: "2026-07-30T00:00:00.000Z",
      });
    }

    const replay = service.beginDelivery(authority, "expired", "fingerprint");
    expect(replay.status).toBe("replayed");
    expect(replay.result).toEqual({
      status: "rejected",
      error: { code: "internal_error", message: "External delivery expired before completion", retryable: true },
    });
    expect(expired.status).toBe("terminal");
    service.finalizeDelivery(authority, "expired", { status: "completed" });
    expect(JSON.parse(expired.result_json ?? "null")).toEqual(replay.result);
    expect(() => service.beginDelivery(authority, "delivery-new", "fingerprint")).not.toThrow();
  });
});
