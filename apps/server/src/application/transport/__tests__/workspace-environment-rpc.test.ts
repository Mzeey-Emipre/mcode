import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routeMessage, type RouterDeps } from "../ws-router.js";
import { WorkspaceEnvironmentService } from "../../../features/projects/environment/workspace-environment-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace environment RPC", () => {
  it("serves valid read/save calls and reports malformed payloads structurally", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-rpc-"));
    roots.push(root);
    const workspaceEnvironmentService = new WorkspaceEnvironmentService(root);
    const deps = {
      workspaceService: { findById: (id: string) => id === "workspace-1" ? { id } : null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const read = await routeMessage(JSON.stringify({ id: "read", method: "workspace.environment.read", params: { workspaceId: "workspace-1" } }), deps);
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({ status: "absent", revision: null });

    const save = await routeMessage(JSON.stringify({
      id: "save",
      method: "workspace.environment.save",
      params: {
        workspaceId: "workspace-1",
        sourceRevision: null,
        document: { version: "0.0.1", actions: [{ id: "action-1", name: "Run app", command: { default: "bun run dev" } }] },
      },
    }), deps);
    expect(save.error).toBeUndefined();
    expect(save.result).toMatchObject({ status: "present" });

    const malformed = await routeMessage(JSON.stringify({
      id: "bad",
      method: "workspace.environment.save",
      params: {
        workspaceId: "workspace-1",
        sourceRevision: null,
        document: { version: "0.0.1", actions: [], extra: true },
      },
    }), deps);
    expect(malformed.error?.code).toBe("WORKSPACE_ENVIRONMENT_VALIDATION");
    expect(malformed.error?.data).toEqual(expect.objectContaining({ issues: expect.any(Array) }));
  });
});
