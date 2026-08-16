import type Database from "better-sqlite3";
import {
  TerminalProfileReferenceSchema,
  WorkspaceTerminalPreferenceSchema,
  type TerminalProfileReference,
  type WorkspaceTerminalPreference,
} from "@mcode/contracts";
import { inject, injectable } from "tsyringe";

interface WorkspaceTerminalPreferenceRow {
  workspace_id: string;
  default_profile_id: string;
  updated_at: string;
}

/** Raised when a Terminal preference targets a missing workspace. */
export class TerminalWorkspaceNotFoundError extends Error {
  readonly code = "WORKSPACE_NOT_FOUND" as const;

  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} was not found`);
    this.name = "TerminalWorkspaceNotFoundError";
  }
}

/** Persists explicit workspace-only Terminal default-profile overrides. */
@injectable()
export class WorkspaceTerminalPreferencesService {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Returns the explicit override, or null when the workspace inherits the global default. */
  get(workspaceId: string): WorkspaceTerminalPreference | null {
    this.assertWorkspaceExists(workspaceId);
    const row = this.db.prepare(
      "SELECT workspace_id, default_profile_id, updated_at FROM workspace_terminal_preferences WHERE workspace_id = ?",
    ).get(workspaceId) as WorkspaceTerminalPreferenceRow | undefined;
    return row ? this.parseRow(row) : null;
  }

  /** Creates or replaces one explicit workspace Terminal profile override. */
  update(
    workspaceId: string,
    defaultProfileId: TerminalProfileReference,
  ): WorkspaceTerminalPreference {
    this.assertWorkspaceExists(workspaceId);
    const profileId = TerminalProfileReferenceSchema().parse(defaultProfileId);
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_terminal_preferences (workspace_id, default_profile_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        default_profile_id = excluded.default_profile_id,
        updated_at = excluded.updated_at
    `).run(workspaceId, profileId, updatedAt);
    return WorkspaceTerminalPreferenceSchema().parse({
      workspaceId,
      defaultProfileId: profileId,
      updatedAt,
    });
  }

  /** Deletes one explicit override so the workspace inherits the global default. */
  reset(workspaceId: string): boolean {
    this.assertWorkspaceExists(workspaceId);
    return this.db.prepare(
      "DELETE FROM workspace_terminal_preferences WHERE workspace_id = ?",
    ).run(workspaceId).changes > 0;
  }

  /** Lists workspace IDs that currently use the given profile as their default. */
  listReferences(profileId: TerminalProfileReference): string[] {
    const validated = TerminalProfileReferenceSchema().parse(profileId);
    return (this.db.prepare(
      "SELECT workspace_id FROM workspace_terminal_preferences WHERE default_profile_id = ? ORDER BY workspace_id",
    ).all(validated) as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
  }

  private assertWorkspaceExists(workspaceId: string): void {
    const workspace = this.db.prepare(
      "SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL",
    ).get(workspaceId);
    if (!workspace) {
      throw new TerminalWorkspaceNotFoundError(workspaceId);
    }
  }

  private parseRow(row: WorkspaceTerminalPreferenceRow): WorkspaceTerminalPreference {
    return WorkspaceTerminalPreferenceSchema().parse({
      workspaceId: row.workspace_id,
      defaultProfileId: row.default_profile_id,
      updatedAt: row.updated_at,
    });
  }
}
