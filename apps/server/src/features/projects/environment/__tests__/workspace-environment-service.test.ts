import "reflect-metadata";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceEnvironmentService,
  WorkspaceEnvironmentServiceError,
} from "../workspace-environment-service.js";
import { WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES } from "@mcode/contracts";

const workspaceId = "workspace-1";
const document = {
  version: "0.0.1" as const,
  actions: [{ id: "action-1", name: "Run app", command: { default: "bun run dev" } }],
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function service(): Promise<{ root: string; instance: WorkspaceEnvironmentService }> {
  const root = await mkdtemp(join(tmpdir(), "mcode-environment-"));
  roots.push(root);
  return { root, instance: new WorkspaceEnvironmentService(root) };
}

describe("WorkspaceEnvironmentService", () => {
  it("reads an absent default and saves at projects/<workspace-id>/environment.json", async () => {
    const { root, instance } = await service();
    const absent = await instance.read(workspaceId);
    expect(absent).toEqual({ document: { version: "0.0.1", actions: [] }, revision: null, status: "absent" });
    const saved = await instance.save({ workspaceId, sourceRevision: absent.revision, document });
    expect(saved.document).toEqual(document);
    expect(saved.revision).toBeTruthy();
    expect(await readFile(join(root, "projects", workspaceId, "environment.json"), "utf8")).toContain('"version":"0.0.1"');
  });

  it("replaces atomically and rejects stale saves without changing newer bytes", async () => {
    const { root, instance } = await service();
    const first = await instance.save({ workspaceId, sourceRevision: null, document });
    const newer = await instance.save({ workspaceId, sourceRevision: first.revision, document: { ...document, actions: [] } });
    const path = join(root, "projects", workspaceId, "environment.json");
    const before = await readFile(path, "utf8");
    await expect(instance.save({ workspaceId, sourceRevision: first.revision, document })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(newer.revision).not.toBe(first.revision);
    expect((await readdir(join(root, "projects", workspaceId))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent saves so exactly one wins a shared revision", async () => {
    const { root, instance } = await service();
    const firstDocument = { ...document, actions: [{ ...document.actions[0], name: "First" }] };
    const secondDocument = { ...document, actions: [{ ...document.actions[0], name: "Second" }] };
    const saves = await Promise.allSettled([
      instance.save({ workspaceId, sourceRevision: null, document: firstDocument }),
      instance.save({ workspaceId, sourceRevision: null, document: secondDocument }),
    ]);
    const successes = saves.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<WorkspaceEnvironmentService["save"]>>> => result.status === "fulfilled");
    const stale = saves.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    const persisted = await instance.read(workspaceId);
    expect(persisted.document).toEqual(successes[0]?.value.document);
    expect(await readFile(join(root, "projects", workspaceId, "environment.json"), "utf8")).toContain(persisted.document.actions[0]?.name);
  });

  it("rejects oversized persisted bytes before parsing and preserves the file", async () => {
    const { root, instance } = await service();
    const path = join(root, "projects", workspaceId, "environment.json");
    await mkdir(join(root, "projects", workspaceId), { recursive: true });
    const oversized = `${JSON.stringify({ version: "0.0.1", actions: [] })}${" ".repeat(128 * 1024)}`;
    await writeFile(path, oversized);
    await expect(instance.read(workspaceId)).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_VALIDATION",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DOCUMENT_TOO_LARGE", reason: "document_too_large" }),
      ]),
    });
    expect(await readFile(path, "utf8")).toBe(oversized);
  });

  it("persists near-limit documents canonically within the raw byte bound", async () => {
    const { root, instance } = await service();
    const nearLimit = {
      version: "0.0.1" as const,
      actions: Array.from({ length: 256 }, (_, index) => ({
        id: `${index}${"i".repeat(40 - String(index).length)}`,
        name: "n".repeat(150),
        command: { default: "x".repeat(250) },
      })),
    };
    const encoder = new TextEncoder();
    expect(encoder.encode(JSON.stringify(nearLimit)).byteLength).toBeLessThanOrEqual(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);
    expect(encoder.encode(`${JSON.stringify(nearLimit, null, 2)}\n`).byteLength).toBeGreaterThan(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);

    const saved = await instance.save({ workspaceId, sourceRevision: null, document: nearLimit });
    const path = join(root, "projects", workspaceId, "environment.json");
    const raw = await readFile(path);
    expect(raw.byteLength).toBeLessThanOrEqual(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);
    expect((await instance.read(workspaceId)).document).toEqual(saved.document);
  });

  it("keeps existing bytes when validation or unsupported-version checks fail", async () => {
    const { root, instance } = await service();
    const saved = await instance.save({ workspaceId, sourceRevision: null, document });
    const path = join(root, "projects", workspaceId, "environment.json");
    const before = await readFile(path, "utf8");
    await expect(instance.save({ workspaceId, sourceRevision: saved.revision, document: { ...document, setup: {} } })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_VALIDATION" });
    expect(await readFile(path, "utf8")).toBe(before);

    await writeFile(path, JSON.stringify({ ...document, version: "9.9.9" }));
    await expect(instance.read(workspaceId)).rejects.toBeInstanceOf(WorkspaceEnvironmentServiceError);
    await expect(instance.save({ workspaceId, sourceRevision: saved.revision, document })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION" });
    expect(await readFile(path, "utf8")).toContain('"version":"9.9.9"');
  });
});
