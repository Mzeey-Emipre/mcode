import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import type {
  ExternalThreadControlAuthority,
  ExternalThreadControlScope,
} from "@mcode/thread-orchestration";

const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DELIVERIES_PER_INTEGRATION = 10_000;
const CREDENTIAL_BYTES = 32;
const EXTERNAL_MCP_ENDPOINT = "/mcp/external-thread-control";
const VALID_SCOPES = new Set<ExternalThreadControlScope>([
  "projects:read",
  "worktrees:read",
  "threads:create",
  "threads:read-owned",
  "threads:read-project",
  "threads:send-owned",
  "threads:send-project",
  "threads:stop-owned",
  "threads:stop-project",
  "worktrees:create",
  "execution:full",
]);

type PairingStatus = "active" | "revoked";
type DeliveryStatus = "in_flight" | "terminal";

/** Input used by the authenticated local pairing-management methods. */
export interface ExternalThreadControlPairingInput {
  integrationId: string;
  workspaceIds: readonly string[];
  scopes: readonly ExternalThreadControlScope[];
  callsPerMinute: number;
  maxActiveThreads: number;
}

/** Durable pairing record. Credential material is intentionally absent. */
export interface ExternalThreadControlPairingRecord {
  pairingId: string;
  integrationId: string;
  workspaceIds: readonly string[];
  scopes: readonly ExternalThreadControlScope[];
  callsPerMinute: number;
  maxActiveThreads: number;
  status: PairingStatus;
  authorityEpoch: number;
  createdAt: string;
  updatedAt: string;
  replacedByPairingId?: string;
  replacesPairingId?: string;
}

/** Pairing record plus one-time plaintext credential returned by creation. */
export interface ExternalThreadControlPairingSecret extends ExternalThreadControlPairingRecord {
  credential: string;
  externalMcpEndpoint: string;
}

/** Authenticated, server-derived authority accepted by ThreadControlService. */
export interface ExternalThreadControlAuthenticatedPairing {
  pairing: ExternalThreadControlPairingRecord;
  authority: ExternalThreadControlAuthority;
}

/** One durable replay result returned by delivery reservation. */
export interface ExternalThreadControlDeliveryResult {
  status: "replayed" | "joined" | "reserved";
  key: string;
  result?: Record<string, unknown>;
}

/** Errors raised by pairing authentication, replay, and rate-limit boundaries. */
export class ExternalThreadControlPairingError extends Error {
  constructor(
    readonly code: "unauthorized" | "stale_epoch" | "conflict" | "rate_limited" | "replay_capacity",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ExternalThreadControlPairingError";
  }
}

interface PairingRow {
  pairing_id: string;
  integration_id: string;
  credential_hash: string;
  workspace_ids_json: string;
  scopes_json: string;
  calls_per_minute: number;
  max_active_threads: number;
  status: PairingStatus;
  authority_epoch: number;
  created_at: string;
  updated_at: string;
  replaced_by_pairing_id: string | null;
  replaces_pairing_id: string | null;
}

interface DeliveryRow {
  pairing_id: string;
  authority_epoch: number;
  delivery_id: string;
  fingerprint: string;
  status: DeliveryStatus;
  result_json: string | null;
  expires_at: string;
}

/** Owns durable external pairings, credential hashing, replay retention, and rate reservations. */
@injectable()
export class ExternalThreadControlPairingService {
  constructor(@inject("Database") private readonly db: Database) {}

  /** Create a pairing and return its plaintext credential exactly once. */
  create(input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    const normalized = normalizePairingInput(input);
    const pairingId = NodeCrypto.randomUUID();
    const credential = NodeCrypto.randomBytes(CREDENTIAL_BYTES).toString("base64url");
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      const active = this.db.prepare(
        "SELECT pairing_id FROM external_thread_control_pairings WHERE integration_id = ? AND status = 'active' LIMIT 1",
      ).get(normalized.integrationId) as { pairing_id: string } | undefined;
      if (active) {
        throw new ExternalThreadControlPairingError("conflict", "External integration already has an active pairing");
      }
      this.db.prepare(
        `INSERT INTO external_thread_control_pairings
         (pairing_id, integration_id, credential_hash, workspace_ids_json, scopes_json,
          calls_per_minute, max_active_threads, status, authority_epoch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      ).run(
        pairingId,
        normalized.integrationId,
        hashCredential(credential),
        JSON.stringify(normalized.workspaceIds),
        JSON.stringify(normalized.scopes),
        normalized.callsPerMinute,
        normalized.maxActiveThreads,
        now,
        now,
      );
    });
    create();
    return { ...this.requireById(pairingId), credential, externalMcpEndpoint: EXTERNAL_MCP_ENDPOINT };
  }

  /** Named alias used by management callers that model pairings as resources. */
  createPairing(input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    return this.create(input);
  }

  /** Look up a pairing without exposing its credential hash. */
  findById(pairingId: string): ExternalThreadControlPairingRecord | undefined {
    const row = this.db.prepare(
      "SELECT pairing_id, integration_id, credential_hash, workspace_ids_json, scopes_json, calls_per_minute, max_active_threads, status, authority_epoch, created_at, updated_at, replaced_by_pairing_id, replaces_pairing_id FROM external_thread_control_pairings WHERE pairing_id = ?",
    ).get(pairingId) as PairingRow | undefined;
    return row ? rowToPairing(row) : undefined;
  }

  /** Revoke one pairing. Repeated revocation is idempotent. */
  revoke(pairingId: string): ExternalThreadControlPairingRecord {
    const pairing = this.requireById(pairingId);
    const now = new Date().toISOString();
    const revoke = this.db.transaction(() => {
      const result = this.db.prepare(
        "UPDATE external_thread_control_pairings SET status = 'revoked', updated_at = ? WHERE pairing_id = ? AND status = 'active'",
      ).run(now, pairingId);
      if (result.changes === 1 && pairing.status === "active") {
        this.db.prepare(
          "UPDATE thread_control_approvals SET status = 'failed', resolved_at = ? WHERE caller_id = ? AND status IN ('pending', 'processing')",
        ).run(now, pairing.integrationId);
      }
    });
    revoke();
    return this.requireById(pairingId);
  }

  /** Named alias used by management callers that model pairings as resources. */
  revokePairing(pairingId: string): ExternalThreadControlPairingRecord {
    return this.revoke(pairingId);
  }

  /** Atomically revoke old authority and create a successor with the next epoch. */
  replace(pairingId: string, input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    const old = this.requireById(pairingId);
    if (old.status !== "active") {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    const normalized = normalizePairingInput(input);
    if (normalized.integrationId !== old.integrationId) {
      throw new ExternalThreadControlPairingError("conflict", "Pairing replacement must preserve integration identity");
    }
    const successorId = NodeCrypto.randomUUID();
    const credential = NodeCrypto.randomBytes(CREDENTIAL_BYTES).toString("base64url");
    const now = new Date().toISOString();
    const replace = this.db.transaction(() => {
      const result = this.db.prepare(
        "UPDATE external_thread_control_pairings SET status = 'revoked', replaced_by_pairing_id = ?, updated_at = ? WHERE pairing_id = ? AND status = 'active'",
      ).run(successorId, now, pairingId);
      if (result.changes !== 1) {
        throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
      }
      // Pending approvals are pre-dispatch external work. Replacement closes
      // them before successor authority becomes visible, preventing a late
      // callback from dispatching under the revoked epoch.
      this.db.prepare(
        "UPDATE thread_control_approvals SET status = 'failed', resolved_at = ? WHERE caller_id = ? AND status IN ('pending', 'processing')",
      ).run(now, old.integrationId);
      this.db.prepare(
        `INSERT INTO external_thread_control_pairings
         (pairing_id, integration_id, credential_hash, workspace_ids_json, scopes_json,
          calls_per_minute, max_active_threads, status, authority_epoch, created_at, updated_at, replaces_pairing_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(
        successorId,
        normalized.integrationId,
        hashCredential(credential),
        JSON.stringify(normalized.workspaceIds),
        JSON.stringify(normalized.scopes),
        normalized.callsPerMinute,
        normalized.maxActiveThreads,
        old.authorityEpoch + 1,
        now,
        now,
        pairingId,
      );
    });
    replace();
    return { ...this.requireById(successorId), credential, externalMcpEndpoint: EXTERNAL_MCP_ENDPOINT };
  }

  /** Named alias for atomic pairing replacement. */
  replacePairing(pairingId: string, input: ExternalThreadControlPairingInput): ExternalThreadControlPairingSecret {
    return this.replace(pairingId, input);
  }

  /** Derive identity and epoch from credential before any replay lookup. */
  authenticate(
    credential: string,
    assertedPairingId?: string,
    assertedAuthorityEpoch?: number,
  ): ExternalThreadControlAuthenticatedPairing {
    if (credential.length < 1 || credential.length > 256) {
      throw new ExternalThreadControlPairingError("unauthorized", "External thread-control pairing denied");
    }
    const digest = hashCredential(credential);
    const row = this.db.prepare(
      "SELECT pairing_id, integration_id, credential_hash, workspace_ids_json, scopes_json, calls_per_minute, max_active_threads, status, authority_epoch, created_at, updated_at, replaced_by_pairing_id, replaces_pairing_id FROM external_thread_control_pairings WHERE credential_hash = ?",
    ).get(digest) as PairingRow | undefined;
    if (!row || !constantTimeHashEqual(row.credential_hash, digest)) {
      throw new ExternalThreadControlPairingError("unauthorized", "External thread-control pairing denied");
    }
    if (row.status !== "active") {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    if (assertedPairingId !== undefined && assertedPairingId !== row.pairing_id) {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    if (assertedAuthorityEpoch !== undefined && assertedAuthorityEpoch !== row.authority_epoch) {
      throw new ExternalThreadControlPairingError("stale_epoch", "External thread-control pairing is stale");
    }
    const pairing = rowToPairing(row);
    return {
      pairing,
      authority: {
        type: "external",
        pairingId: pairing.pairingId,
        authorityEpoch: pairing.authorityEpoch,
        integrationId: pairing.integrationId,
        allowedWorkspaceIds: pairing.workspaceIds,
        scopes: pairing.scopes,
        limits: {
          callsPerMinute: pairing.callsPerMinute,
          maxActiveThreads: pairing.maxActiveThreads,
        },
      },
    };
  }

  /** Named alias emphasizing that callers receive derived authority, not grants. */
  authorize(
    credential: string,
    assertedPairingId?: string,
    assertedAuthorityEpoch?: number,
  ): ExternalThreadControlAuthenticatedPairing {
    return this.authenticate(credential, assertedPairingId, assertedAuthorityEpoch);
  }

  /** Reserve one delivery, joining or replaying an existing key without rate cost. */
  beginDelivery(
    pairing: ExternalThreadControlAuthenticatedPairing,
    deliveryId: string,
    fingerprint: string,
  ): ExternalThreadControlDeliveryResult {
    if (!/^[\x21-\x7e]{1,256}$/.test(deliveryId)) {
      throw new ExternalThreadControlPairingError("conflict", "External delivery id is invalid");
    }
    if (fingerprint.length < 1 || fingerprint.length > 256) {
      throw new ExternalThreadControlPairingError("conflict", "External delivery fingerprint is invalid");
    }
    const key = `${pairing.pairing.pairingId}:${pairing.pairing.authorityEpoch}:${deliveryId}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + DELIVERY_RETENTION_MS).toISOString();
    const reserve = this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM external_thread_control_deliveries WHERE status = 'terminal' AND expires_at <= ?",
      ).run(nowIso);
      this.db.prepare(
        `UPDATE external_thread_control_deliveries
         SET status = 'terminal', result_json = ?, updated_at = ?
         WHERE status = 'in_flight' AND expires_at <= ?`,
      ).run(
        JSON.stringify({ status: "rejected", error: { code: "internal_error", message: "External delivery expired before completion", retryable: true } }),
        nowIso,
        nowIso,
      );
      const existing = this.db.prepare(
        "SELECT pairing_id, authority_epoch, delivery_id, fingerprint, status, result_json FROM external_thread_control_deliveries WHERE pairing_id = ? AND authority_epoch = ? AND delivery_id = ?",
      ).get(pairing.pairing.pairingId, pairing.pairing.authorityEpoch, deliveryId) as DeliveryRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new ExternalThreadControlPairingError("conflict", "External delivery fingerprint conflict");
        }
        return existing;
      }
      const count = this.db.prepare(
        `SELECT COUNT(*) AS count FROM external_thread_control_deliveries d
         JOIN external_thread_control_pairings p ON p.pairing_id = d.pairing_id
         WHERE p.integration_id = ?`,
      ).get(pairing.pairing.integrationId) as { count: number };
      if (count.count >= MAX_DELIVERIES_PER_INTEGRATION) {
        const removable = this.db.prepare(
          `SELECT d.pairing_id, d.authority_epoch, d.delivery_id
           FROM external_thread_control_deliveries d
           JOIN external_thread_control_pairings p ON p.pairing_id = d.pairing_id
           WHERE p.integration_id = ? AND d.status = 'terminal'
           ORDER BY d.updated_at ASC LIMIT 1`,
        ).get(pairing.pairing.integrationId) as { pairing_id: string; authority_epoch: number; delivery_id: string } | undefined;
        if (!removable) {
          throw new ExternalThreadControlPairingError("replay_capacity", "External replay retention is full", 60);
        }
        this.db.prepare(
          "DELETE FROM external_thread_control_deliveries WHERE pairing_id = ? AND authority_epoch = ? AND delivery_id = ? AND status = 'terminal'",
        ).run(removable.pairing_id, removable.authority_epoch, removable.delivery_id);
      }
      const cutoffIso = new Date(now.getTime() - 60_000).toISOString();
      const recent = this.db.prepare(
        `SELECT COUNT(*) AS count FROM external_thread_control_deliveries d
         JOIN external_thread_control_pairings p ON p.pairing_id = d.pairing_id
         WHERE p.integration_id = ? AND d.created_at > ?`,
      ).get(pairing.pairing.integrationId, cutoffIso) as { count: number };
      if (recent.count >= pairing.pairing.callsPerMinute) {
        throw new ExternalThreadControlPairingError("rate_limited", "External call rate limit exceeded", 60);
      }
      this.db.prepare(
        `INSERT INTO external_thread_control_deliveries
         (pairing_id, authority_epoch, delivery_id, fingerprint, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 'in_flight', ?, ?, ?)`,
      ).run(pairing.pairing.pairingId, pairing.pairing.authorityEpoch, deliveryId, fingerprint, nowIso, nowIso, expiresAt);
      return undefined;
    })();
    if (reserve?.status === "terminal") {
      return { status: "replayed", key, result: parseResult(reserve.result_json) };
    }
    if (reserve?.status === "in_flight") return { status: "joined", key };
    return { status: "reserved", key };
  }

  /** Persist one terminal replay result. Safe to call repeatedly for one delivery. */
  finalizeDelivery(pairing: ExternalThreadControlAuthenticatedPairing, deliveryId: string, result: Record<string, unknown>): void {
    const resultJson = JSON.stringify(result);
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE external_thread_control_deliveries
       SET status = 'terminal', result_json = ?, updated_at = ?
       WHERE pairing_id = ? AND authority_epoch = ? AND delivery_id = ? AND status = 'in_flight'`,
    ).run(resultJson, now, pairing.pairing.pairingId, pairing.pairing.authorityEpoch, deliveryId);
  }

  /** Reconcile uncertain work after restart without redispatching it. */
  reconcileInFlight(): number {
    const result = this.db.prepare(
      `UPDATE external_thread_control_deliveries
       SET status = 'terminal', result_json = ?, updated_at = ?
       WHERE status = 'in_flight'`,
    ).run(
      JSON.stringify({ status: "rejected", error: { code: "internal_error", message: "External delivery outcome was reconciled after restart", retryable: true } }),
      new Date().toISOString(),
    );
    return result.changes;
  }

  private requireById(pairingId: string): ExternalThreadControlPairingRecord {
    const pairing = this.findById(pairingId);
    if (!pairing) throw new ExternalThreadControlPairingError("unauthorized", "External thread-control pairing not found");
    return pairing;
  }
}

function normalizePairingInput(input: ExternalThreadControlPairingInput): ExternalThreadControlPairingInput {
  const integrationId = input.integrationId.trim();
  const workspaceIds = normalizeWorkspaceIds(input.workspaceIds);
  const scopes = [...new Set(input.scopes)];
  if (!isValidPairingPolicy(input, integrationId, workspaceIds, scopes)) {
    throw new ExternalThreadControlPairingError("conflict", "External pairing policy is invalid");
  }
  return {
    integrationId,
    workspaceIds,
    scopes,
    callsPerMinute: Math.trunc(input.callsPerMinute),
    maxActiveThreads: Math.trunc(input.maxActiveThreads),
  };
}

function normalizeWorkspaceIds(workspaceIds: readonly string[]): string[] {
  return [...new Set(workspaceIds.map((value) => value.trim()).filter(Boolean))];
}

function isValidPairingPolicy(
  input: ExternalThreadControlPairingInput,
  integrationId: string,
  workspaceIds: string[],
  scopes: ExternalThreadControlScope[],
): boolean {
  return isValidIntegrationId(integrationId)
    && isValidWorkspaceIds(workspaceIds)
    && scopes.every((scope) => VALID_SCOPES.has(scope))
    && isIntegerWithin(input.callsPerMinute, 1, 10_000)
    && isIntegerWithin(input.maxActiveThreads, 1, 1_000);
}

function isValidIntegrationId(integrationId: string): boolean {
  return integrationId.length > 0 && integrationId.length <= 128;
}

function isValidWorkspaceIds(workspaceIds: string[]): boolean {
  return workspaceIds.length <= 100 && workspaceIds.every((workspaceId) => workspaceId.length <= 128);
}

function isIntegerWithin(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function rowToPairing(row: PairingRow): ExternalThreadControlPairingRecord {
  const workspaceIds = JSON.parse(row.workspace_ids_json) as string[];
  const scopes = JSON.parse(row.scopes_json) as ExternalThreadControlScope[];
  return {
    pairingId: row.pairing_id,
    integrationId: row.integration_id,
    workspaceIds,
    scopes,
    callsPerMinute: row.calls_per_minute,
    maxActiveThreads: row.max_active_threads,
    status: row.status,
    authorityEpoch: row.authority_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.replaced_by_pairing_id ? { replacedByPairingId: row.replaced_by_pairing_id } : {}),
    ...(row.replaces_pairing_id ? { replacesPairingId: row.replaces_pairing_id } : {}),
  };
}

function hashCredential(credential: string): string {
  return NodeCrypto.createHash("sha256").update(credential, "utf8").digest("hex");
}

function constantTimeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseResult(resultJson: string | null): Record<string, unknown> {
  if (!resultJson) return { status: "rejected", error: { code: "internal_error", message: "External delivery outcome unavailable", retryable: true } };
  try {
    const value = JSON.parse(resultJson) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : { status: "rejected", error: { code: "internal_error", message: "External delivery outcome invalid", retryable: true } };
  } catch {
    return { status: "rejected", error: { code: "internal_error", message: "External delivery outcome invalid", retryable: true } };
  }
}

/** Return the loopback path used by the external MCP adapter. */
export function externalThreadControlMcpEndpoint(): string {
  return EXTERNAL_MCP_ENDPOINT;
}
