import "reflect-metadata";
import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCatalogService } from "../codex-catalog-service.js";
import type { SkillsListResult } from "../../providers/codex/codex-types.js";

class ControlledCatalogClient extends EventEmitter {
  isAlive = true;
  readonly start = vi.fn(async () => undefined);
  readonly kill = vi.fn(async () => {
    this.isAlive = false;
  });
  readonly listSkills = vi.fn(async (cwds?: string[]): Promise<SkillsListResult> => {
    const cwd = cwds?.[0] ?? "";
    return {
      data: [{
        cwd,
        errors: [],
        skills: [
          {
            name: "review",
            description: "Global review",
            enabled: true,
            path: "C:/users/test/.codex/skills/review/SKILL.md",
            scope: "user",
          },
          {
            name: "review",
            description: `Project review for ${cwd}`,
            enabled: true,
            path: `${cwd}/.codex/skills/review/SKILL.md`,
            scope: "repo",
          },
        ],
      }],
    };
  });
}

describe("CodexCatalogService", () => {
  const services: CodexCatalogService[] = [];

  function createService(
    client: ControlledCatalogClient,
    create: () => ControlledCatalogClient = () => client,
  ): CodexCatalogService {
    const service = new CodexCatalogService(
      { get: () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      { isWindowsJob: false } as never,
      { getEnv: () => ({}) } as never,
      { create } as never,
    );
    services.push(service);
    return service;
  }

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    vi.useRealTimers();
  });

  it("uses one lazy app-server connection for distinct working-directory catalogs", async () => {
    const client = new ControlledCatalogClient();
    const create = vi.fn(() => client);
    const service = createService(client, create);

    expect(create).not.toHaveBeenCalled();

    const first = await service.refresh("C:/workspaces/one");
    const second = await service.refresh("C:/workspaces/two");

    expect(create).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.listSkills.mock.calls).toEqual([
      [["C:/workspaces/one"], false],
      [["C:/workspaces/two"], false],
    ]);
    expect(first.skills.map((skill) => skill.path)).toEqual([
      "C:/users/test/.codex/skills/review/SKILL.md",
      "C:/workspaces/one/.codex/skills/review/SKILL.md",
    ]);
    expect(second.skills.map((skill) => skill.path)).toEqual([
      "C:/users/test/.codex/skills/review/SKILL.md",
      "C:/workspaces/two/.codex/skills/review/SKILL.md",
    ]);
  });

  it("reconciles the affected context after skills/changed", async () => {
    const client = new ControlledCatalogClient();
    const service = createService(client);
    const cwd = "C:/workspaces/one";
    await service.refresh(cwd);
    client.listSkills.mockResolvedValueOnce({
      data: [{
        cwd,
        errors: [],
        skills: [{
          name: "ship",
          description: "Ship changes",
          enabled: true,
          path: `${cwd}/.codex/skills/ship/SKILL.md`,
          scope: "repo",
        }],
      }],
    });
    const changed = new Promise<string | undefined>((resolve) => {
      service.onSkillsChanged(resolve);
    });

    client.emit("notification", { method: "skills/changed", params: { cwd } });

    await expect(changed).resolves.toBe(cwd);
    expect(client.listSkills).toHaveBeenLastCalledWith([cwd], true);
    expect(service.currentSkills(cwd).map((skill) => skill.name)).toEqual(["ship"]);
  });

  it("releases the catalog connection after 60 seconds without a request", async () => {
    vi.useFakeTimers();
    const client = new ControlledCatalogClient();
    const service = createService(client);
    await service.refresh("C:/workspaces/one");

    await vi.advanceTimersByTimeAsync(60_001);

    expect(client.kill).toHaveBeenCalledTimes(1);
  });

  it("preserves the context snapshot and scopes diagnostics after a provider failure", async () => {
    const client = new ControlledCatalogClient();
    const service = createService(client);
    const cwd = "C:/workspaces/one";
    const first = await service.refresh(cwd);
    client.listSkills.mockRejectedValueOnce(new Error("provider unavailable"));

    const failed = await service.refresh(cwd);

    expect(failed.skills).toEqual(first.skills);
    expect(failed.freshness).toMatchObject({ status: "stale" });
    expect(failed.diagnostics).toEqual([{
      severity: "warning",
      code: "source-unavailable",
      message: "Codex Skills are temporarily unavailable for this catalog context.",
    }]);
  });

  it("isolates invalid native metadata while retaining valid Skills", async () => {
    const client = new ControlledCatalogClient();
    const cwd = "C:/workspaces/one";
    client.listSkills.mockResolvedValueOnce({
      data: [{
        cwd,
        errors: [],
        skills: [
          { name: "invalid", description: "Invalid", enabled: true, path: null, scope: "repo" },
          {
            name: "ship",
            description: "Ship changes",
            enabled: true,
            path: `${cwd}/.codex/skills/ship/SKILL.md`,
            scope: "repo",
          },
        ],
      }],
    } as never);
    const service = createService(client);

    const result = await service.refresh(cwd);

    expect(result.skills.map((skill) => skill.name)).toEqual(["ship"]);
    expect(result.diagnostics).toContainEqual({
      severity: "warning",
      code: "partial-result",
      message: "Some Codex Skills were omitted because their metadata was invalid.",
    });
  });

  it("does not cache a different cwd when the requested context is omitted", async () => {
    const client = new ControlledCatalogClient();
    client.listSkills.mockResolvedValueOnce({
      data: [{
        cwd: "C:/workspaces/other",
        errors: [],
        skills: [{
          name: "other",
          description: "Other workspace",
          enabled: true,
          path: "C:/workspaces/other/.codex/skills/other/SKILL.md",
          scope: "repo",
        }],
      }],
    });
    const service = createService(client);

    const result = await service.refresh("C:/workspaces/requested");

    expect(result.skills).toEqual([]);
    expect(result.freshness.status).toBe("stale");
    expect(service.currentSkills("C:/workspaces/requested")).toEqual([]);
  });

  it("ignores malformed skills/changed notifications", async () => {
    const client = new ControlledCatalogClient();
    const service = createService(client);
    await service.refresh("C:/workspaces/one");

    expect(() => client.emit("notification", null)).not.toThrow();
    client.emit("notification", {
      method: "skills/changed",
      params: { cwds: ["x".repeat(4_097)] },
    });
    await Promise.resolve();

    expect(client.listSkills).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest catalog context when the context limit is reached", async () => {
    const client = new ControlledCatalogClient();
    const service = createService(client);
    for (let index = 0; index < 65; index += 1) {
      await service.refresh(`C:/workspaces/${index}`);
    }
    client.listSkills.mockClear();

    client.emit("notification", {
      method: "skills/changed",
      params: { cwd: "C:/workspaces/0" },
    });
    await Promise.resolve();

    expect(client.listSkills).not.toHaveBeenCalled();
    expect(service.currentSkills("C:/workspaces/0")).toEqual([]);
  });
});
