/**
 * Workspace CRUD service.
 * Thin orchestration layer over WorkspaceRepo.
 */

import { injectable, inject } from "tsyringe";
import type { Workspace } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";

/** Handles workspace creation, listing, and deletion. */
@injectable()
export class WorkspaceService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  /** Create a new workspace with the given name and filesystem path. */
  create(name: string, path: string): Workspace {
    return this.workspaceRepo.create(name, path);
  }

  /** List all workspaces ordered by most recently updated. */
  list(): Workspace[] {
    return this.workspaceRepo.listAll();
  }

  /** Delete a workspace by ID. Returns true if the workspace was removed. */
  delete(id: string): boolean {
    return this.workspaceRepo.remove(id);
  }

  /** Find a workspace by its primary key. Returns null if not found. */
  findById(id: string): Workspace | null {
    return this.workspaceRepo.findById(id);
  }
}
