import type { Database } from "bun:sqlite";
import type { WorkspaceEnvironmentStorageMode } from "@mcode/contracts";

/** Persists one Project's active environment location and shared-command approvals. */
export class WorkspaceEnvironmentConfigurationRepo {
  constructor(private readonly db: Database) {}

  /** Returns the explicit storage choice, if this Project has one. */
  storageMode(workspaceId: string): WorkspaceEnvironmentStorageMode | null {
    const row = this.db.prepare(
      "SELECT storage_mode FROM workspace_environment_storage_settings WHERE workspace_id = ?",
    ).get(workspaceId) as { storage_mode: string } | undefined;
    return row?.storage_mode === "shared" || row?.storage_mode === "system" ? row.storage_mode : null;
  }

  /** Stores the exclusive environment location for one Project. */
  setStorageMode(workspaceId: string, storageMode: WorkspaceEnvironmentStorageMode): void {
    this.db.prepare(
      `INSERT INTO workspace_environment_storage_settings (workspace_id, storage_mode, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(workspace_id) DO UPDATE SET storage_mode = excluded.storage_mode, updated_at = excluded.updated_at`,
    ).run(workspaceId, storageMode);
  }

  /** Reports whether this Project command has approval for the exact fingerprint. */
  hasApproval(workspaceId: string, commandId: string, fingerprint: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 AS approved FROM workspace_environment_command_approvals WHERE workspace_id = ? AND command_id = ? AND fingerprint = ?",
    ).get(workspaceId, commandId, fingerprint) as { approved: number } | undefined;
    return row?.approved === 1;
  }

  /** Replaces the approval for one stable Project command. */
  approve(workspaceId: string, commandId: string, fingerprint: string): void {
    this.db.prepare(
      `INSERT INTO workspace_environment_command_approvals (workspace_id, command_id, fingerprint, approved_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(workspace_id, command_id) DO UPDATE SET fingerprint = excluded.fingerprint, approved_at = excluded.approved_at`,
    ).run(workspaceId, commandId, fingerprint);
  }

  /** Removes every stored command approval for one Project. */
  clearApprovals(workspaceId: string): void {
    this.db.prepare("DELETE FROM workspace_environment_command_approvals WHERE workspace_id = ?").run(workspaceId);
  }
}
