import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { WebSocket } from "ws";
import { routeMessage, type RouterDeps } from "../ws-router.js";
import { CodexCatalogService } from "../../../features/providers/catalog/codex-catalog-service.js";
import { ProviderCatalogService } from "../../../features/providers/catalog/provider-catalog-service.js";
import { ProviderCatalogSnapshotRepo } from "../../../features/providers/catalog/persistence/provider-catalog-snapshot-repo.js";
import { openMemoryDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../features/thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../features/projects/persistence/workspace-repo.js";
import type { ProjectActionService } from "../../../features/projects/environment/project-action-service.js";
import { WorkspaceEnvironmentService } from "../../../features/projects/environment/workspace-environment-service.js";
import { _resetForTest, addClient } from "../push.js";
import {
  RECAP_MAX_MESSAGE_CONTENT_CHARS,
  RECAP_MAX_MESSAGES,
  RECAP_MAX_PREVIOUS_RECAP_CHARS,
} from "@mcode/contracts";
import {
  resetTransportPayloadValidatorForTest,
  setTransportPayloadValidatorForTest,
  type TransportPayloadValidator,
} from "../payload-validation.js";

function fakeOpenSocket(received: Array<{ buf: Buffer; binary: boolean }>): WebSocket {
  const ws: Partial<WebSocket> = {
    readyState: 1,
    OPEN: 1,
    send: ((data: unknown, opts?: { binary?: boolean }) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as Uint8Array);
      received.push({ buf, binary: !!opts?.binary });
    }) as WebSocket["send"],
  };
  return ws as WebSocket;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createIdempotentRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
  };
}

function createProjectActionServiceMock() {
  const beginWorkspaceTeardown = vi.fn(async () => createIdempotentRelease());
  const beginThreadTeardown = vi.fn(async () => createIdempotentRelease());
  const stopForThread = vi.fn(async () => undefined);
  const service = {
    onUpdate: vi.fn(() => () => undefined),
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    start: vi.fn(async () => { throw new Error("Project Action start was not configured for this router test"); }),
    stop: vi.fn(async () => null),
    restart: vi.fn(async () => { throw new Error("Project Action restart was not configured for this router test"); }),
    stopForThread,
    beginThreadTeardown,
    beginWorkspaceTeardown,
    reopenThread: vi.fn(),
    dispose: vi.fn(async () => undefined),
    recoverStaleRuns: vi.fn(() => []),
  } satisfies Pick<
    ProjectActionService,
    | "onUpdate"
    | "list"
    | "get"
    | "start"
    | "stop"
    | "restart"
    | "stopForThread"
    | "beginThreadTeardown"
    | "beginWorkspaceTeardown"
    | "reopenThread"
    | "dispose"
    | "recoverStaleRuns"
  >;
  return { service, beginWorkspaceTeardown, beginThreadTeardown, stopForThread };
}

describe("routeMessage result validation seam", () => {
  afterEach(() => {
    resetTransportPayloadValidatorForTest();
  });

  it("delegates RPC result validation to the configured adapter", async () => {
    const validateRpcResult = vi.fn();
    const validator: TransportPayloadValidator = {
      validatePush: (_channel, data) => ({ ok: true, data }),
      validateRpcResult,
    };
    setTransportPayloadValidatorForTest(validator);

    const response = await routeMessage(
      JSON.stringify({ id: "req-1", method: "app.version", params: {} }),
      {} as RouterDeps,
    );

    expect(response.id).toBe("req-1");
    expect(typeof response.result).toBe("string");
    expect(validateRpcResult).toHaveBeenCalledWith(
      "app.version",
      response.result,
      expect.anything(),
    );
  });
});

describe("routeMessage agent.child.stop", () => {
  it("routes the distinct child-stop action to AgentService", async () => {
    const stopChildTurn = vi.fn().mockResolvedValue({
      childThreadId: "child-thread",
      status: "interrupted",
    });

    const response = await routeMessage(JSON.stringify({
      id: "child-stop-1",
      method: "agent.child.stop",
      params: {
        owningParentThreadId: "parent-thread",
        childThreadId: "child-thread",
      },
    }), {
      agentService: { stopChildTurn },
    } as unknown as RouterDeps);

    expect(response).toEqual({
      id: "child-stop-1",
      result: { childThreadId: "child-thread", status: "interrupted" },
    });
    expect(stopChildTurn).toHaveBeenCalledWith("parent-thread", "child-thread");
  });
});

describe("routeMessage snapshot.getCumulativeDiffStats", () => {
  it("rejects results above the Review comparison file bound before returning them", async () => {
    const getDiffStats = vi.fn().mockResolvedValue(
      Array.from({ length: 10_001 }, (_, index) => ({
        filePath: `file-${index}.ts`,
        additions: 1,
        deletions: 0,
      })),
    );
    const deps = {
      turnSnapshotRepo: {
        listByThread: vi.fn().mockReturnValue([{
          id: "snapshot-1",
          thread_id: "thread-1",
          ref_before: "before",
          ref_after: "after",
          files_changed: [],
          worktree_path: "C:/repo",
          created_at: "2026-07-20T12:00:00.000Z",
        }]),
      },
      snapshotService: { getDiffStats },
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "cumulative-stats-bound",
      method: "snapshot.getCumulativeDiffStats",
      params: { threadId: "thread-1" },
    }), deps);

    expect(response.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Cumulative Review comparison is limited to 10000 files",
    });
    expect(getDiffStats).toHaveBeenCalledOnce();
  });
});

describe("routeMessage provider.catalog", () => {
  it("merges scoped standalone agents and non-colliding config registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-provider-catalog-ws-"));
    const codexHome = join(root, "codex-home");
    const cwd = join(root, "workspace");
    await mkdir(join(codexHome, "agents"), { recursive: true });
    await mkdir(join(cwd, ".codex", "agents"), { recursive: true });
    await Promise.all([
      writeFile(
        join(codexHome, "agents", "reviewer.toml"),
        'name = "reviewer"\ndescription = "Global review"\n',
      ),
      writeFile(
        join(codexHome, "agents", "global-only.toml"),
        'name = "global-only"\n',
      ),
      writeFile(
        join(cwd, ".codex", "agents", "reviewer.toml"),
        'name = "reviewer"\ndescription = "Project review"\n',
      ),
      writeFile(join(cwd, ".codex", "agents", "broken.toml"), 'name = "broken\n'),
    ]);
    const client = Object.assign(new EventEmitter(), {
      isAlive: true,
      start: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
      listSkills: vi.fn(async (cwds?: string[]) => ({
        data: [{ cwd: cwds?.[0] ?? "", errors: [], skills: [] }],
      })),
      listPlugins: vi.fn(async () => ({
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      })),
      readPlugin: vi.fn(async () => ({ plugin: {} })),
      readConfig: vi.fn(async (configCwd?: string) => ({
        config: {
          agents: {
            reviewer: {
              description: "Configured review",
              config_file: "C:/config/reviewer.toml",
            },
            configured_only: {
              description: `Configured for ${configCwd}`,
              config_file: "C:/config/configured-only.toml",
            },
          },
        },
      })),
    });
    const codexCatalogService = new CodexCatalogService(
      { get: () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      { isWindowsJob: false } as never,
      { getEnv: () => ({ CODEX_HOME: codexHome }) } as never,
      { create: () => client } as never,
      {
        refresh: vi.fn(async () => ({ prompts: [], diagnostics: [], available: true })),
        currentPrompts: vi.fn(() => []),
      } as never,
    );
    const db = openMemoryDatabase();
    const providerCatalogService = new ProviderCatalogService(
      new ProviderCatalogSnapshotRepo(db),
    );
    const deps = {
      codexCatalogService,
      providerCatalogService,
      skillService: { list: vi.fn(() => []) },
    } as unknown as RouterDeps;

    try {
      const changed = new Promise<import("@mcode/contracts").ProviderCatalogChange>((resolve) => {
        providerCatalogService.onChanged(resolve);
      });
      const response = await routeMessage(JSON.stringify({
        id: "catalog-agents",
        method: "provider.catalog",
        params: { providerId: "codex", cwd },
      }), deps);

      expect(response.result).toMatchObject({
        freshness: { status: "stale" },
        selectableAgents: [],
      });
      await expect(changed).resolves.toMatchObject({
        selectableAgents: {
          additions: expect.arrayContaining([
            expect.objectContaining({ name: "global-only" }),
            expect.objectContaining({ name: "reviewer", description: "Project review" }),
            expect.objectContaining({ name: "configured_only" }),
          ]),
        },
        diagnostics: [expect.objectContaining({
          code: "discovery-error",
          rejectedSource: "broken.toml",
        })],
      });
      expect(client.readConfig).toHaveBeenCalledWith(cwd);
    } finally {
      await codexCatalogService.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes standalone agents when the app-server catalog fails on first load", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-provider-catalog-offline-ws-"));
    const codexHome = join(root, "codex-home");
    const cwd = join(root, "workspace");
    await mkdir(join(codexHome, "agents"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(codexHome, "agents", "offline-review.toml"),
      'name = "offline-review"\ndescription = "Standalone review"\n',
    );
    const client = Object.assign(new EventEmitter(), {
      isAlive: true,
      start: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
      listSkills: vi.fn(async () => {
        throw new Error("unavailable");
      }),
      listPlugins: vi.fn(async () => ({
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      })),
      readPlugin: vi.fn(async () => ({ plugin: {} })),
      readConfig: vi.fn(async () => ({ config: {} })),
    });
    const codexCatalogService = new CodexCatalogService(
      { get: () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      { isWindowsJob: false } as never,
      { getEnv: () => ({ CODEX_HOME: codexHome }) } as never,
      { create: () => client } as never,
      {
        refresh: vi.fn(async () => ({ prompts: [], diagnostics: [], available: true })),
        currentPrompts: vi.fn(() => []),
      } as never,
    );
    const db = openMemoryDatabase();
    const providerCatalogService = new ProviderCatalogService(
      new ProviderCatalogSnapshotRepo(db),
    );
    const deps = {
      codexCatalogService,
      providerCatalogService,
      skillService: { list: vi.fn(() => []) },
    } as unknown as RouterDeps;

    try {
      const changed = new Promise<import("@mcode/contracts").ProviderCatalogChange>((resolve) => {
        providerCatalogService.onChanged(resolve);
      });
      const response = await routeMessage(JSON.stringify({
        id: "catalog-offline-agents",
        method: "provider.catalog",
        params: { providerId: "codex", cwd },
      }), deps);

      expect(response.result).toMatchObject({
        freshness: { status: "stale" },
        selectableAgents: [],
      });
      await expect(changed).resolves.toMatchObject({
        freshness: { status: "fresh" },
        selectableAgents: {
          additions: [expect.objectContaining({
            name: "offline-review",
            description: "Standalone review",
          })],
        },
        diagnostics: [expect.objectContaining({
          code: "source-unavailable",
          message: expect.stringContaining("agent registrations"),
        })],
      });
    } finally {
      await codexCatalogService.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns persisted Codex Skills immediately and reconciles refreshes in the background", async () => {
    let catalogVersion = 1;
    const client = Object.assign(new EventEmitter(), {
      isAlive: true,
      start: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
      readConfig: vi.fn(async (cwd?: string) => ({
        config: {
          agents: {
            configured_reviewer: {
              description: `Configured reviewer for ${cwd ?? "user"}`,
              config_file: "C:/users/test/.codex/agents/configured-reviewer.toml",
            },
          },
        },
      })),
      listSkills: vi.fn(async (cwds?: string[]) => {
        const cwd = cwds?.[0] ?? "";
        const projectSkill = catalogVersion === 1 ? "review" : "ship";
        return {
        data: [{
          cwd,
          errors: [],
          skills: [
            {
              name: "review",
              description: "Review global changes",
              enabled: true,
              scope: "user",
              path: "C:/users/test/.codex/skills/review/SKILL.md",
            },
            {
              name: "prompts:release",
              description: "A Skill with the same name as a custom prompt",
              enabled: true,
              scope: "user",
              path: "C:/users/test/.codex/skills/prompts-release/SKILL.md",
            },
            {
              name: projectSkill,
              description: `${projectSkill} project changes`,
              enabled: true,
              scope: "repo",
              path: `${cwd}/.codex/skills/${projectSkill}/SKILL.md`,
            },
          ],
        }],
        };
      }),
      listPlugins: vi.fn(async (cwds?: string[]) => ({
        marketplaces: [{
          name: "personal",
          path: "C:/marketplaces/personal",
          interface: null,
          plugins: catalogVersion === 1
            ? [
                {
                  id: "review@personal",
                  name: "review",
                  installed: true,
                  enabled: true,
                  interface: {
                    displayName: "review",
                    shortDescription: `Review plugin for ${cwds?.[0] ?? "user"}`,
                    capabilities: ["mcp"],
                  },
                },
                {
                  id: "disabled@personal",
                  name: "disabled",
                  installed: true,
                  enabled: false,
                  interface: { shortDescription: "Disabled" },
                },
              ]
            : [{
                id: "browser@personal",
                name: "browser",
                installed: true,
                enabled: true,
                interface: { shortDescription: "Browse pages", capabilities: ["mcp"] },
              }],
        }],
        marketplaceLoadErrors: catalogVersion === 1
          ? [{
              marketplacePath: "C:/marketplaces/broken.json",
              message: "invalid metadata",
            }]
          : [],
        featuredPluginIds: [],
      })),
      readPlugin: vi.fn(async () => ({ plugin: { description: "Plugin details" } })),
    });
    const create = vi.fn(() => client);
    const customPrompt = {
      name: "prompts:release",
      description: "Prepare a release",
      kind: "command" as const,
      source: "user" as const,
      providers: ["codex"],
      nativeName: "release",
      path: "C:/users/test/.codex/prompts/release.md",
    };
    const customPromptService = {
      refresh: vi.fn(async () => ({
        prompts: [customPrompt],
        diagnostics: [],
        available: true,
      })),
      currentPrompts: vi.fn(() => [customPrompt]),
    };
    const codexCatalogService = new CodexCatalogService(
      { get: () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      { isWindowsJob: false } as never,
      { getEnv: () => ({}) } as never,
      { create } as never,
      customPromptService as never,
    );
    const refresh = vi.spyOn(codexCatalogService, "refresh");
    const db = openMemoryDatabase();
    const insertWorkspace = db.prepare(
      "INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)",
    );
    insertWorkspace.run("workspace-1", "Workspace 1", "C:/repo");
    insertWorkspace.run("workspace-2", "Workspace 2", "C:/other");
    const snapshotRepo = new ProviderCatalogSnapshotRepo(db);
    const providerCatalogService = new ProviderCatalogService(snapshotRepo);
    const list = vi.fn().mockImplementation((_cwd, _providerId, discoveredSkills = []) => (
      discoveredSkills
    ));
    const threadLookup = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn((workspaceId: string) => ({
          id: workspaceId,
          path: workspaceId === "workspace-2" ? "C:/other" : "C:/repo",
        })),
      },
      threadRepo: { findById: threadLookup },
      codexCatalogService,
      providerCatalogService,
      skillService: { list },
    } as unknown as RouterDeps;

    const firstChange = new Promise<import("@mcode/contracts").ProviderCatalogChange>((resolve) => {
      providerCatalogService.onChanged(resolve);
    });

    const response = await routeMessage(JSON.stringify({
      id: "catalog-1",
      method: "provider.catalog",
      params: { providerId: "codex", workspaceId: "workspace-1" },
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      providerId: "codex",
      context: { scope: "workspace", workspaceId: "workspace-1" },
      freshness: { status: "stale" },
      diagnostics: [],
      entries: [],
    });
    await expect(firstChange).resolves.toMatchObject({
      request: { providerId: "codex", workspaceId: "workspace-1" },
      additions: expect.arrayContaining([
        expect.objectContaining({ name: "review", kind: "skill" }),
        expect.objectContaining({
          name: "review",
          kind: "plugin",
          mentionPath: "plugin://review@personal",
        }),
        expect.objectContaining({ name: "prompts:release", kind: "skill" }),
        expect.objectContaining({ name: "prompts:release", kind: "customPrompt" }),
      ]),
      diagnostics: [expect.objectContaining({
        code: "discovery-error",
        sourceKind: "appServerPlugins",
        rejectedSource: "broken.json",
      })],
      freshness: { status: "fresh" },
      selectableAgents: {
        additions: [expect.objectContaining({ name: "configured_reviewer" })],
      },
    });
    expect(refresh).toHaveBeenCalledWith("C:/repo");
    expect(threadLookup).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.listSkills).toHaveBeenCalledWith(["C:/repo"], false);
    expect(client.listPlugins).toHaveBeenCalledWith(["C:/repo"]);
    expect(client.readPlugin).not.toHaveBeenCalled();
    expect(client.readConfig).toHaveBeenCalledWith("C:/repo");
    expect(list).not.toHaveBeenCalled();
    expect((response.result as {
      selectableAgents: Array<{ providerId: string; nativeId: string }>;
    }).selectableAgents.every((agent) => agent.providerId === "codex" && agent.nativeId.length > 0))
      .toBe(true);

    const restartedCatalogService = new ProviderCatalogService(snapshotRepo);
    (deps as { providerCatalogService: ProviderCatalogService }).providerCatalogService = restartedCatalogService;
    const restartedChange = new Promise<import("@mcode/contracts").ProviderCatalogChange>((resolve) => {
      restartedCatalogService.onChanged((change) => {
        if (change.request.workspaceId === "workspace-1") resolve(change);
      });
    });
    const restartedResponse = await routeMessage(JSON.stringify({
      id: "catalog-restarted",
      method: "provider.catalog",
      params: { providerId: "codex", workspaceId: "workspace-1" },
    }), deps);
    expect(restartedResponse.result).toMatchObject({
      freshness: { status: "stale" },
      entries: expect.arrayContaining([
        expect.objectContaining({ name: "review" }),
        expect.objectContaining({ name: "prompts:release" }),
      ]),
    });
    await restartedChange;

    const otherWorkspaceChange = new Promise<import("@mcode/contracts").ProviderCatalogChange>((resolve) => {
      restartedCatalogService.onChanged((change) => {
        if (change.request.workspaceId === "workspace-2") resolve(change);
      });
    });
    const otherWorkspaceResponse = await routeMessage(JSON.stringify({
      id: "catalog-2",
      method: "provider.catalog",
      params: { providerId: "codex", workspaceId: "workspace-2" },
    }), deps);
    expect(otherWorkspaceResponse.error).toBeUndefined();
    expect((otherWorkspaceResponse.result as { entries: unknown[] }).entries).toEqual([]);
    await otherWorkspaceChange;
    expect(client.listSkills).toHaveBeenLastCalledWith(["C:/other"], false);

    catalogVersion = 2;
    const refreshed = new Promise<string | undefined>((resolve) => {
      codexCatalogService.onSkillsChanged(resolve);
    });
    codexCatalogService.onSkillsChanged((cwd) => {
      restartedCatalogService.refreshKnownContexts("codex", cwd);
    });
    const reconciled = new Promise<import("@mcode/contracts").ProviderCatalogChange>((resolve) => {
      restartedCatalogService.onChanged((change) => {
        if (change.request.workspaceId === "workspace-1") resolve(change);
      });
    });
    client.emit("notification", { method: "skills/changed", params: { cwd: "C:/repo" } });
    await expect(refreshed).resolves.toBe("C:/repo");
    expect(client.listSkills).toHaveBeenCalledWith(["C:/repo"], true);
    await expect(reconciled).resolves.toMatchObject({
      additions: expect.arrayContaining([
        expect.objectContaining({ kind: "skill", name: "ship" }),
        expect.objectContaining({ kind: "plugin", name: "browser" }),
      ]),
      removals: expect.arrayContaining([
        expect.objectContaining({ nativeId: "C:/repo/.codex/skills/review/SKILL.md" }),
        expect.objectContaining({ nativeId: "review@personal", kind: "plugin" }),
      ]),
    });
    expect(create).toHaveBeenCalledTimes(1);

    refresh.mockRejectedValueOnce(new Error("provider unavailable"));
    const failedRefresh = new Promise<import("@mcode/contracts").ProviderCatalogChange>((resolve) => {
      restartedCatalogService.onChanged((change) => {
        if (change.request.workspaceId === "workspace-1") resolve(change);
      });
    });
    const failureResponse = await routeMessage(JSON.stringify({
      id: "catalog-failure",
      method: "provider.catalog",
      params: { providerId: "codex", workspaceId: "workspace-1" },
    }), deps);
    expect(failureResponse.result).toMatchObject({
      freshness: { status: "stale" },
      entries: expect.arrayContaining([expect.objectContaining({ name: "ship" })]),
    });
    await expect(failedRefresh).resolves.toMatchObject({
      additions: [],
      updates: [],
      removals: [],
      diagnostics: [expect.objectContaining({ code: "source-unavailable" })],
      freshness: { status: "stale" },
    });
    await codexCatalogService.shutdown();
    db.close();
  });

  it("rejects unknown providers and oversized contexts before dispatch", async () => {
    const deps = { skillService: { list: vi.fn() } } as unknown as RouterDeps;
    const unknownProvider = await routeMessage(JSON.stringify({
      id: "catalog-unknown",
      method: "provider.catalog",
      params: { providerId: "unknown" },
    }), deps);
    const oversizedContext = await routeMessage(JSON.stringify({
      id: "catalog-oversized",
      method: "provider.catalog",
      params: { providerId: "codex", cwd: "x".repeat(4_097) },
    }), deps);

    expect(unknownProvider.error?.code).toBe("INVALID_PARAMS");
    expect(oversizedContext.error?.code).toBe("INVALID_PARAMS");
    expect(deps.skillService.list).not.toHaveBeenCalled();
  });

  it("rejects a thread owned by another workspace", async () => {
    const deps = {
      workspaceService: { findById: vi.fn().mockReturnValue({ id: "workspace-1", path: "C:/repo" }) },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          workspace_id: "workspace-2",
          mode: "direct",
          worktree_path: null,
        }),
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "catalog-owner",
      method: "provider.catalog",
      params: { providerId: "claude", workspaceId: "workspace-1", threadId: "thread-1" },
    }), deps);

    expect(response.error?.code).toBe("INTERNAL_ERROR");
    expect(response.error?.message).toContain("does not belong to workspace");
  });
});

describe("routeMessage agent commands", () => {
  const capture = {
    schemaVersion: 2,
    pageUrl: "http://localhost:5173/products/1",
    pageTitle: "Product",
    capturedAt: "2026-07-01T00:00:00.000Z",
    captureKind: "element",
    selectorHint: "button.buy",
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    visibleTextExcerpt: "Buy now",
    layoutViewport: { width: 1200, height: 800 },
  };
  const previewAnnotations = {
    schemaVersion: 1,
    annotations: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        displayNumber: 1,
        pageIdentity: "http://localhost:5173/products/1",
        pageContext: capture,
        targetContext: {
          label: "button.buy",
          selectorHint: "button.buy",
          bounds: { x: 10, y: 20, width: 100, height: 40 },
        },
        note: "Make the button clearer.",
        snapshot: {
          id: "snap-1",
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 123,
          sourcePath: "C:/tmp/preview.png",
          capture,
        },
      },
    ],
  };

  it("augments an existing-thread command while preserving its display content and annotations", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const deps = { agentService: { sendMessage } } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-send",
        method: "agent.send",
        params: {
          threadId: "thread-1",
          content: "Inspect this change",
          displayContent: "Inspect the highlighted button",
          model: "gpt-5",
          provider: "codex",
          interactionMode: "build",
          permissionMode: "full",
          thinking: false,
          previewAnnotations,
        },
      }),
      deps,
    );

    expect(response.error).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: "thread-1",
      content: `Inspect this change

<!-- mcode-preview-annotations:v1
${JSON.stringify(previewAnnotations)}
mcode-preview-annotations:end -->`,
      displayContent: "Inspect the highlighted button",
      model: "gpt-5",
      provider: "codex",
      interactionMode: "build",
      permissionMode: "full",
      thinking: false,
      previewAnnotations,
    });
  });

  it("augments a new-thread command while falling back to raw display content", async () => {
    const createAndSend = vi.fn().mockResolvedValue({
      id: "thread-2",
      mode: "direct",
      worktree_path: null,
    });
    const deps = { agentService: { createAndSend } } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create-send",
        method: "agent.createAndSend",
        params: {
          workspaceId: "workspace-1",
          content: "Start here",
          model: "gpt-5",
          provider: "codex",
          mode: "direct",
          previewAnnotations,
        },
      }),
      deps,
    );

    expect(response.error).toBeUndefined();
    expect(createAndSend).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      content: `Start here

<!-- mcode-preview-annotations:v1
${JSON.stringify(previewAnnotations)}
mcode-preview-annotations:end -->`,
      displayContent: "Start here",
      model: "gpt-5",
      provider: "codex",
      mode: "direct",
      previewAnnotations,
    });
  });
});

describe("routeMessage git.getRemoteUrl", () => {
  it("resolves the git path from a workspace thread before calling GitService", async () => {
    const getRemoteUrl = vi.fn().mockResolvedValue({
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      label: "Mzeey-Empire/mcode",
    });
    const resolveWorkingDir = vi.fn().mockReturnValue("C:/repo-worktree");
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "C:/repo" }),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          workspace_id: "ws-1",
          mode: "worktree",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitService: {
        getRemoteUrl,
        resolveWorkingDir,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-remote",
        method: "git.getRemoteUrl",
        params: { workspaceId: "ws-1", threadId: "thread-1" },
      }),
      deps,
    );

    expect(response.result).toEqual({
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      label: "Mzeey-Empire/mcode",
    });
    expect(resolveWorkingDir).toHaveBeenCalledWith(
      "C:/repo",
      "worktree",
      "C:/repo-worktree",
    );
    expect(getRemoteUrl).toHaveBeenCalledWith("C:/repo-worktree");
  });

  it("rejects a thread from another workspace before running git", async () => {
    const getRemoteUrl = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "C:/repo" }),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          workspace_id: "ws-2",
          mode: "worktree",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitService: {
        getRemoteUrl,
        resolveWorkingDir: vi.fn(),
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-remote",
        method: "git.getRemoteUrl",
        params: { workspaceId: "ws-1", threadId: "thread-1" },
      }),
      deps,
    );

    expect(response.error?.message).toContain(
      "Thread thread-1 does not belong to workspace ws-1",
    );
    expect(getRemoteUrl).not.toHaveBeenCalled();
  });
});

describe("routeMessage recap.generate", () => {
  it("delegates valid caller-supplied recap material without resolving thread state", async () => {
    const generate = vi.fn().mockResolvedValue({ text: "Implementing recap.generate." });
    const deps = {
      recapService: { generate },
      threadRepo: { findById: vi.fn() },
      workspaceRepo: { findById: vi.fn() },
      messageRepo: { listByThread: vi.fn() },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-recap",
        method: "recap.generate",
        params: {
          threadId: "thread-1",
          messages: [
            { role: "user", content: "Build recap.generate." },
            { role: "assistant", content: "Adding the RPC and tests." },
          ],
          previousRecap: null,
        },
      }),
      deps,
    );

    expect(response.result).toEqual({ text: "Implementing recap.generate." });
    expect(generate).toHaveBeenCalledWith({
      threadId: "thread-1",
      messages: [
        { role: "user", content: "Build recap.generate." },
        { role: "assistant", content: "Adding the RPC and tests." },
      ],
      previousRecap: null,
    });
    expect(deps.threadRepo.findById).not.toHaveBeenCalled();
    expect(deps.workspaceRepo.findById).not.toHaveBeenCalled();
    expect(deps.messageRepo.listByThread).not.toHaveBeenCalled();
  });

  it("rejects invalid message roles before dispatch", async () => {
    const generate = vi.fn();
    const deps = {
      recapService: { generate },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-recap-role",
        method: "recap.generate",
        params: {
          threadId: "thread-1",
          messages: [{ role: "system", content: "hidden context" }],
          previousRecap: null,
        },
      }),
      deps,
    );

    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects oversized recap payloads before prompt assembly", async () => {
    const generate = vi.fn();
    const deps = {
      recapService: { generate },
    } as unknown as RouterDeps;

    const tooManyMessages = Array.from(
      { length: RECAP_MAX_MESSAGES + 1 },
      () => ({ role: "user", content: "hello" }),
    );

    for (const params of [
      {
        threadId: "thread-1",
        messages: [{ role: "user", content: "x".repeat(RECAP_MAX_MESSAGE_CONTENT_CHARS + 1) }],
        previousRecap: null,
      },
      {
        threadId: "thread-1",
        messages: tooManyMessages,
        previousRecap: null,
      },
      {
        threadId: "thread-1",
        messages: [{ role: "user", content: "hello" }],
        previousRecap: "x".repeat(RECAP_MAX_PREVIOUS_RECAP_CHARS + 1),
      },
    ]) {
      const response = await routeMessage(
        JSON.stringify({
          id: "req-recap-oversized",
          method: "recap.generate",
          params,
        }),
        deps,
      );

      expect(response.error?.code).toBe("INVALID_PARAMS");
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects omitted previousRecap before dispatch", async () => {
    const generate = vi.fn();
    const deps = {
      recapService: { generate },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-recap-previous-missing",
        method: "recap.generate",
        params: {
          threadId: "thread-1",
          messages: [{ role: "user", content: "Build recap.generate." }],
        },
      }),
      deps,
    );

    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("routeMessage git.createBranch", () => {
  afterEach(() => {
    _resetForTest();
  });

  it("delegates branch creation, then broadcasts the persisted checkout state", async () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(received));
    const createBranchForThread = vi.fn().mockResolvedValue("feat/from-thread");
    const findById = vi.fn().mockReturnValue({
      id: "thread-1",
      workspace_id: "ws-1",
      branch: "feat/from-thread",
      checkout_state: "named",
      base_branch: null,
      pr_number: null,
      pr_status: null,
    });
    const deps = {
      threadService: {
        findById,
      },
      handoffCheckoutService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", threadId: "thread-1", name: "feat/from-thread" },
      }),
      deps,
    );

    expect(response.result).toEqual({ branch: "feat/from-thread" });
    expect(createBranchForThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "feat/from-thread",
    );
    expect(findById).toHaveBeenCalledWith("thread-1");
    expect(JSON.parse(received[0].buf.toString("utf-8"))).toMatchObject({
      channel: "thread.checkoutChanged",
      data: {
        threadId: "thread-1",
        workspaceId: "ws-1",
        branch: "feat/from-thread",
        checkoutState: "named",
        baseBranch: null,
        prNumber: null,
        prStatus: null,
      },
    });
  });

  it("returns an error when the new branch cannot be attached to the thread", async () => {
    const createBranchForThread = vi
      .fn()
      .mockRejectedValue(new Error("Failed to update checkout state for thread thread-1"));
    const deps = {
      handoffCheckoutService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", threadId: "thread-1", name: "feat/from-thread" },
      }),
      deps,
    );

    expect(response.error?.message).toContain(
      "Failed to update checkout state for thread thread-1",
    );
    expect(createBranchForThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "feat/from-thread",
    );
  });

  it("surfaces service rejection before returning a branch", async () => {
    const createBranchForThread = vi
      .fn()
      .mockRejectedValue(new Error("Thread thread-1 does not belong to workspace ws-1"));
    const deps = {
      handoffCheckoutService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", threadId: "thread-1", name: "feat/from-thread" },
      }),
      deps,
    );

    expect(response.error?.message).toContain(
      "Thread thread-1 does not belong to workspace ws-1",
    );
    expect(createBranchForThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "feat/from-thread",
    );
  });

  it("rejects invalid branch names before dispatch", async () => {
    const createBranchForThread = vi.fn();
    const deps = {
      handoffCheckoutService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", name: "bad;name" },
      }),
      deps,
    );

    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(createBranchForThread).not.toHaveBeenCalled();
  });
});

describe("routeMessage thread.create", () => {
  it("creates new worktree threads as branchless", async () => {
    const create = vi.fn().mockReturnValue({
      id: "thread-1",
      workspace_id: "ws-1",
      title: "New thread",
      status: "active",
      mode: "worktree",
      worktree_path: "C:/repo-worktree",
      branch: "main",
      checkout_state: "branchless",
      base_branch: "main",
      worktree_managed: true,
      issue_number: null,
      pr_number: null,
      pr_status: null,
      sdk_session_id: null,
      model: null,
      provider: "claude",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
      deleted_at: null,
      last_context_tokens: null,
      context_window: null,
      reasoning_level: null,
      interaction_mode: null,
      permission_mode: null,
      context_window_mode: null,
      thinking: null,
      codex_fast_mode: null,
      copilot_agent: null,
      default_open_in_app: null,
      parent_thread_id: null,
      forked_from_message_id: null,
      last_compact_summary: null,
      has_file_changes: false,
    });
    const deps = {
      threadService: { create },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-create",
        method: "thread.create",
        params: {
          workspaceId: "ws-1",
          title: "New thread",
          mode: "worktree",
          branch: "main",
        },
      }),
      deps,
    );

    expect(response.result).toMatchObject({
      id: "thread-1",
      checkout_state: "branchless",
      base_branch: "main",
    });
    expect(create).toHaveBeenCalledWith(
      "ws-1",
      "New thread",
      "worktree",
      "main",
      { branchless: true },
    );
  });
});

describe("routeMessage workspace.delete watcher teardown", () => {
  it("keeps thread worktree watchers when any workspace thread teardown fails", async () => {
    const unwatchThreadWorktree = vi.fn();
    const deleteWorkspace = vi.fn();
    const projectActions = createProjectActionServiceMock();
    const deps = {
      threadRepo: {
        listAllByWorkspace: vi.fn().mockReturnValue([
          { id: "thread-1", worktree_path: null },
          { id: "thread-2", worktree_path: null },
        ]),
      },
      githubService: {
        cancelForRepoPath: vi.fn().mockResolvedValue(undefined),
      },
      ciWatcherService: {
        teardownThread: vi.fn().mockResolvedValue(undefined),
      },
      threadTeardownService: {
        teardownThread: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("teardown failed")),
      },
      gitWatcherService: {
        unwatchThreadWorktree,
      },
      workspaceService: {
        delete: deleteWorkspace,
      },
      workspaceEnvironmentService: {
        cancelSetupForWorkspace: vi.fn().mockResolvedValue(undefined),
        beginWorkspaceDeletion: vi.fn(() => () => undefined),
      },
      projectActionService: projectActions.service,
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-workspace-delete",
        method: "workspace.delete",
        params: { id: "ws-1" },
      }),
      deps,
    );

    expect(response.error?.message).toContain("Workspace teardown failed for ws-1");
    expect(unwatchThreadWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
  });

  it("unwatches thread worktrees after all workspace thread teardowns succeed", async () => {
    const unwatchThreadWorktree = vi.fn();
    const teardownThread = vi.fn().mockResolvedValue(undefined);
    const cancelSetupForWorkspace = vi.fn().mockResolvedValue(undefined);
    const projectActions = createProjectActionServiceMock();
    const deps = {
      threadRepo: {
        listAllByWorkspace: vi.fn().mockReturnValue([
          { id: "thread-1", worktree_path: null },
          { id: "thread-2", worktree_path: null },
        ]),
      },
      githubService: {
        cancelForRepoPath: vi.fn().mockResolvedValue(undefined),
      },
      ciWatcherService: {
        teardownThread: vi.fn().mockResolvedValue(undefined),
      },
      threadTeardownService: {
        teardownThread,
      },
      gitWatcherService: {
        unwatchThreadWorktree,
        unwatchWorkspace: vi.fn(),
      },
      workspaceService: {
        delete: vi.fn().mockReturnValue(true),
      },
      workspaceEnvironmentService: {
        cancelSetupForWorkspace,
        beginWorkspaceDeletion: vi.fn(() => () => undefined),
      },
      projectActionService: projectActions.service,
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-workspace-delete",
        method: "workspace.delete",
        params: { id: "ws-1" },
      }),
      deps,
    );

    expect(response.result).toBe(true);
    expect(unwatchThreadWorktree).toHaveBeenCalledWith("thread-1");
    expect(unwatchThreadWorktree).toHaveBeenCalledWith("thread-2");
    expect(teardownThread.mock.invocationCallOrder[1]).toBeLessThan(
      unwatchThreadWorktree.mock.invocationCallOrder[0],
    );
    expect(cancelSetupForWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      teardownThread.mock.invocationCallOrder[0],
    );
    expect(projectActions.beginWorkspaceTeardown).toHaveBeenCalledWith("ws-1");
    expect(projectActions.beginThreadTeardown).toHaveBeenCalledWith("thread-1");
    expect(projectActions.beginThreadTeardown).toHaveBeenCalledWith("thread-2");
    expect(projectActions.stopForThread.mock.invocationCallOrder[0]).toBeLessThan(
      teardownThread.mock.invocationCallOrder[0],
    );
  });
});

describe("routeMessage thread completion lifecycle", () => {
  afterEach(() => {
    _resetForTest();
  });

  it("broadcasts persisted completion to every client", async () => {
    const firstClient: Array<{ buf: Buffer; binary: boolean }> = [];
    const secondClient: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(firstClient));
    addClient(fakeOpenSocket(secondClient));
    const db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const thread = threadRepo.create(
      workspaceRepo.create("Project", "C:/repo", true).id,
      "Complete me",
      "direct",
      "main",
    );
    const completed = threadRepo.complete(
      thread.id,
      "2026-08-12T08:00:00.000Z",
      "2026-08-15T08:00:00.000Z",
    )!;
    const complete = vi.fn().mockResolvedValue(completed);
    const deps = {
      threadCompletionService: { complete },
      threadRepo,
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "req-complete",
      method: "thread.complete",
      params: { threadId: thread.id },
    }), deps);

    expect(response.result).toEqual(completed);
    for (const received of [firstClient, secondClient]) {
      expect(JSON.parse(received[0].buf.toString("utf-8"))).toMatchObject({
        channel: "thread.lifecycleChanged",
        data: { thread: completed },
      });
    }
  });
});

describe("routeMessage thread.delete watcher teardown", () => {
  function createThreadDeleteDeps(options: {
    teardown?: () => Promise<void>;
    deleteThread?: () => Promise<boolean>;
  } = {}) {
    const unwatchThreadWorktree = vi.fn();
    const teardownThread = vi
      .fn()
      .mockImplementation(options.teardown ?? (() => Promise.resolve()));
    const deleteThread = vi
      .fn()
      .mockImplementation(options.deleteThread ?? (() => Promise.resolve(true)));
    const cancelSetupForThread = vi.fn().mockResolvedValue(undefined);
    const projectActions = createProjectActionServiceMock();
    const deps = {
      ciWatcherService: {
        teardownThread: vi.fn().mockResolvedValue(undefined),
      },
      githubService: {
        cancelForRepoPath: vi.fn().mockResolvedValue(undefined),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitWatcherService: {
        unwatchThreadWorktree,
      },
      threadTeardownService: {
        teardownThread,
      },
      threadService: {
        delete: deleteThread,
      },
      workspaceEnvironmentService: {
        cancelSetupForThread,
        beginThreadDeletion: vi.fn(() => () => undefined),
      },
      projectActionService: projectActions.service,
    } as unknown as RouterDeps;
    return {
      deps,
      unwatchThreadWorktree,
      teardownThread,
      deleteThread,
      cancelSetupForThread,
      projectActions,
    };
  }

  it("keeps the thread worktree watcher when thread teardown fails", async () => {
    const { deps, unwatchThreadWorktree, deleteThread } = createThreadDeleteDeps({
      teardown: () => Promise.reject(new Error("teardown failed")),
    });

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-delete",
        method: "thread.delete",
        params: { threadId: "thread-1", cleanupWorktree: true },
      }),
      deps,
    );

    expect(response.error?.message).toContain("teardown failed");
    expect(unwatchThreadWorktree).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  it("keeps the thread worktree watcher when thread delete returns false", async () => {
    const { deps, unwatchThreadWorktree } = createThreadDeleteDeps({
      deleteThread: () => Promise.resolve(false),
    });

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-delete",
        method: "thread.delete",
        params: { threadId: "thread-1", cleanupWorktree: true },
      }),
      deps,
    );

    expect(response.result).toBe(false);
    expect(unwatchThreadWorktree).not.toHaveBeenCalled();
  });

  it("unwatches the thread worktree after thread teardown and delete succeed", async () => {
    const {
      deps,
      unwatchThreadWorktree,
      teardownThread,
      deleteThread,
      cancelSetupForThread,
      projectActions,
    } = createThreadDeleteDeps();

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-delete",
        method: "thread.delete",
        params: { threadId: "thread-1", cleanupWorktree: true },
      }),
      deps,
    );

    expect(response.result).toBe(true);
    expect(unwatchThreadWorktree).toHaveBeenCalledWith("thread-1");
    expect(teardownThread.mock.invocationCallOrder[0]).toBeLessThan(
      unwatchThreadWorktree.mock.invocationCallOrder[0],
    );
    expect(deleteThread.mock.invocationCallOrder[0]).toBeLessThan(
      unwatchThreadWorktree.mock.invocationCallOrder[0],
    );
    expect(cancelSetupForThread.mock.invocationCallOrder[0]).toBeLessThan(
      teardownThread.mock.invocationCallOrder[0],
    );
    expect(projectActions.beginThreadTeardown).toHaveBeenCalledWith("thread-1");
    expect(projectActions.stopForThread.mock.invocationCallOrder[0]).toBeLessThan(
      teardownThread.mock.invocationCallOrder[0],
    );
  });
});

describe("routeMessage Setup deletion barriers", () => {
  it("rejects Setup during a Thread deletion and releases the barrier after teardown fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-setup-thread-delete-"));
    const thread = { id: "thread-1", workspace_id: "ws-1", mode: "direct", worktree_managed: true };
    const environment = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (threadId) => threadId === thread.id ? thread : null },
    });
    const teardownEntered = deferred<void>();
    const teardown = deferred<void>();
    const projectActions = createProjectActionServiceMock();
    const deps = {
      ciWatcherService: { teardownThread: vi.fn().mockResolvedValue(undefined) },
      githubService: { cancelForRepoPath: vi.fn().mockResolvedValue(undefined) },
      threadRepo: { findById: vi.fn().mockReturnValue({ ...thread, worktree_path: null }) },
      threadTeardownService: {
        teardownThread: vi.fn(() => {
          teardownEntered.resolve();
          return teardown.promise;
        }),
      },
      threadService: { delete: vi.fn().mockResolvedValue(true) },
      workspaceEnvironmentService: environment,
      projectActionService: projectActions.service,
    } as unknown as RouterDeps;

    try {
      const deletion = routeMessage(JSON.stringify({
        id: "thread-delete-barrier",
        method: "thread.delete",
        params: { threadId: thread.id, cleanupWorktree: false },
      }), deps);
      await teardownEntered.promise;

      await expect(environment.startSetup({ threadId: thread.id })).rejects.toMatchObject({
        code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
      });

      teardown.reject(new Error("teardown failed"));
      await expect(deletion).resolves.toMatchObject({ error: { message: "teardown failed" } });
      await expect(environment.startSetup({ threadId: thread.id })).resolves.toMatchObject({ status: "unavailable" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Setup during a workspace deletion and falls back to not found after deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-setup-workspace-delete-"));
    const thread = { id: "thread-1", workspace_id: "ws-1", mode: "direct", worktree_managed: true };
    let deleted = false;
    const environment = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (threadId) => !deleted && threadId === thread.id ? thread : null },
    });
    const teardownEntered = deferred<void>();
    const teardown = deferred<void>();
    const projectActions = createProjectActionServiceMock();
    const deps = {
      threadRepo: { listAllByWorkspace: vi.fn().mockReturnValue([{ ...thread, worktree_path: null }]) },
      githubService: { cancelForRepoPath: vi.fn().mockResolvedValue(undefined) },
      ciWatcherService: { teardownThread: vi.fn().mockResolvedValue(undefined) },
      threadTeardownService: {
        teardownThread: vi.fn(() => {
          teardownEntered.resolve();
          return teardown.promise;
        }),
      },
      gitWatcherService: { unwatchThreadWorktree: vi.fn(), unwatchWorkspace: vi.fn() },
      workspaceService: {
        delete: vi.fn(() => {
          deleted = true;
          return true;
        }),
      },
      workspaceEnvironmentService: environment,
      projectActionService: projectActions.service,
    } as unknown as RouterDeps;

    try {
      const deletion = routeMessage(JSON.stringify({
        id: "workspace-delete-barrier",
        method: "workspace.delete",
        params: { id: "ws-1" },
      }), deps);
      await teardownEntered.promise;

      await expect(environment.startSetup({ threadId: thread.id })).rejects.toMatchObject({
        code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
      });

      teardown.resolve();
      await expect(deletion).resolves.toMatchObject({ result: true });
      await expect(environment.startSetup({ threadId: thread.id })).rejects.toMatchObject({
        code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("routeMessage github.createPr", () => {
  const namedThread = {
    id: "thread-1",
    workspace_id: "ws-1",
    mode: "worktree",
    worktree_path: "C:/repo-worktree",
    branch: "feat/from-thread",
    checkout_state: "named",
  };

  function createGithubPrDeps(thread: typeof namedThread, currentBranch: string | null) {
    const push = vi.fn().mockResolvedValue(undefined);
    const createPr = vi.fn().mockResolvedValue({
      number: 42,
      url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    });
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
          is_git_repo: true,
        }),
      },
      threadService: {
        findById: vi.fn().mockReturnValue(thread),
        linkPr: vi.fn(),
      },
      gitService: {
        resolveWorkingDir: vi.fn().mockReturnValue("C:/repo-worktree"),
        getCurrentBranchAt: vi.fn().mockResolvedValue(currentBranch),
        push,
      },
      githubService: {
        createPr,
      },
      ciWatcherService: {
        unwatch: vi.fn(),
        watch: vi.fn(),
        scheduleBumpAfterPush: vi.fn(),
      },
    } as unknown as RouterDeps;
    return { deps, push, createPr };
  }

  const createPrRequest = {
    id: "req-pr",
    method: "github.createPr",
    params: {
      workspaceId: "ws-1",
      threadId: "thread-1",
      title: "Add branchless worktrees",
      body: "Body",
      baseBranch: "main",
      isDraft: false,
    },
  };

  it("rejects branchless worktree threads without pushing or creating a PR", async () => {
    const { deps, push, createPr } = createGithubPrDeps(
      {
        ...namedThread,
        branch: "main",
        checkout_state: "branchless",
      },
      "HEAD",
    );

    const response = await routeMessage(JSON.stringify(createPrRequest), deps);

    expect(response.error?.message).toContain(
      "must be a named worktree checkout before creating a PR",
    );
    expect(push).not.toHaveBeenCalled();
    expect(createPr).not.toHaveBeenCalled();
  });

  it("rejects mismatched current branch without pushing or creating a PR", async () => {
    const { deps, push, createPr } = createGithubPrDeps(namedThread, "feat/other");

    const response = await routeMessage(JSON.stringify(createPrRequest), deps);

    expect(response.error?.message).toContain(
      "checkout is on feat/other, expected feat/from-thread",
    );
    expect(push).not.toHaveBeenCalled();
    expect(createPr).not.toHaveBeenCalled();
  });

  it("pushes and creates a PR only when thread state and current branch match", async () => {
    const { deps, push, createPr } = createGithubPrDeps(namedThread, "feat/from-thread");

    const response = await routeMessage(JSON.stringify(createPrRequest), deps);

    expect(response.result).toEqual({
      number: 42,
      url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    });
    expect(push).toHaveBeenCalledWith("C:/repo-worktree", "feat/from-thread");
    expect(createPr).toHaveBeenCalledWith({
      cwd: "C:/repo-worktree",
      title: "Add branchless worktrees",
      body: "Body",
      baseBranch: "main",
      isDraft: false,
    });
    expect(deps.threadService.linkPr).toHaveBeenCalledWith("thread-1", 42, "OPEN");
  });
});

describe("routeMessage thread.syncPrs", () => {
  it("checks PRs only for named worktree checkouts", async () => {
    const getBranchPr = vi.fn().mockResolvedValue({
      number: 42,
      state: "open",
    });
    const watch = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
          is_git_repo: true,
        }),
      },
      threadService: {
        list: vi.fn().mockReturnValue([
          {
            id: "branchless-thread",
            branch: "main",
            mode: "worktree",
            checkout_state: "branchless",
            pr_number: null,
            pr_status: null,
          },
          {
            id: "named-thread",
            branch: "feat/named",
            mode: "worktree",
            checkout_state: "named",
            pr_number: null,
            pr_status: null,
          },
          {
            id: "direct-thread",
            branch: "main",
            mode: "direct",
            checkout_state: "named",
            pr_number: null,
            pr_status: null,
          },
        ]),
        linkPr: vi.fn(),
      },
      githubService: {
        getBranchPr,
      },
      ciWatcherService: {
        watch,
        unwatch: vi.fn(),
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-sync",
        method: "thread.syncPrs",
        params: { workspaceId: "ws-1" },
      }),
      deps,
    );

    expect(response.result).toEqual([
      { threadId: "named-thread", prNumber: 42, prStatus: "open" },
    ]);
    expect(getBranchPr).toHaveBeenCalledTimes(1);
    expect(getBranchPr).toHaveBeenCalledWith("feat/named", "C:/repo");
    expect(deps.threadService.linkPr).toHaveBeenCalledWith(
      "named-thread",
      42,
      "open",
    );
    expect(watch).toHaveBeenCalledWith("named-thread", 42, "feat/named", "C:/repo");
  });

  it("refreshes linked pull requests through one batch and stops terminal watchers", async () => {
    const checks = { aggregate: "passing" as const, runs: [], fetchedAt: 1 };
    const getPullRequestWatchSnapshots = vi.fn().mockResolvedValue([
      { threadId: "thread-1", prNumber: 41, state: "OPEN", checks },
      { threadId: "thread-2", prNumber: 42, state: "MERGED", checks },
    ]);
    const watch = vi.fn();
    const refresh = vi.fn();
    const unwatch = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
          is_git_repo: true,
        }),
      },
      threadService: {
        list: vi.fn().mockReturnValue([
          {
            id: "thread-1",
            branch: "feat/one",
            mode: "worktree",
            checkout_state: "named",
            pr_number: 41,
            pr_status: "OPEN",
          },
          {
            id: "thread-2",
            branch: "feat/two",
            mode: "worktree",
            checkout_state: "named",
            pr_number: 42,
            pr_status: "OPEN",
          },
        ]),
        findById: vi.fn().mockImplementation((threadId: string) => ({
          "thread-1": {
            id: "thread-1",
            branch: "feat/one",
            mode: "worktree",
            checkout_state: "named",
            pr_number: 41,
            pr_status: "OPEN",
          },
          "thread-2": {
            id: "thread-2",
            branch: "feat/two",
            mode: "worktree",
            checkout_state: "named",
            pr_number: 42,
            pr_status: "OPEN",
          },
        })[threadId] ?? null),
        linkPr: vi.fn(),
      },
      githubService: {
        getPullRequestWatchSnapshots,
        getBranchPr: vi.fn(),
      },
      ciWatcherService: { watch, refresh, unwatch },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-sync-linked",
        method: "thread.syncPrs",
        params: { workspaceId: "ws-1" },
      }),
      deps,
    );

    expect(getPullRequestWatchSnapshots).toHaveBeenCalledTimes(1);
    expect(getPullRequestWatchSnapshots).toHaveBeenCalledWith([
      { threadId: "thread-1", prNumber: 41, repoPath: "C:/repo" },
      { threadId: "thread-2", prNumber: 42, repoPath: "C:/repo" },
    ]);
    expect(deps.githubService.getBranchPr).not.toHaveBeenCalled();
    expect(response.result).toEqual([
      { threadId: "thread-2", prNumber: 42, prStatus: "MERGED" },
    ]);
    expect(watch).toHaveBeenCalledWith(
      "thread-1",
      41,
      "feat/one",
      "C:/repo",
      { skipInitialFetch: true },
    );
    expect(refresh).toHaveBeenCalledWith("thread-1", checks);
    expect(unwatch).toHaveBeenCalledWith("thread-2");
  });

  it("ignores a linked snapshot when the thread was relinked during the request", async () => {
    const checks = { aggregate: "passing" as const, runs: [], fetchedAt: 1 };
    const linkPr = vi.fn();
    const watch = vi.fn();
    const refresh = vi.fn();
    const unwatch = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
          is_git_repo: true,
        }),
      },
      threadService: {
        list: vi.fn().mockReturnValue([{
          id: "thread-1",
          branch: "feat/one",
          mode: "worktree",
          checkout_state: "named",
          pr_number: 41,
          pr_status: "OPEN",
        }]),
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          branch: "feat/relinked",
          mode: "worktree",
          checkout_state: "named",
          pr_number: 99,
          pr_status: "OPEN",
        }),
        linkPr,
      },
      githubService: {
        getPullRequestWatchSnapshots: vi.fn().mockResolvedValue([{
          threadId: "thread-1",
          prNumber: 41,
          state: "MERGED",
          checks,
        }]),
        getBranchPr: vi.fn(),
      },
      ciWatcherService: { watch, refresh, unwatch },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-sync-stale",
        method: "thread.syncPrs",
        params: { workspaceId: "ws-1" },
      }),
      deps,
    );

    expect(response.result).toEqual([]);
    expect(linkPr).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(unwatch).not.toHaveBeenCalled();
  });
});

describe("routeMessage github.checkStatus", () => {
  it("does not bootstrap check polling for branchless worktree threads", async () => {
    const getCheckRuns = vi.fn();
    const watch = vi.fn();
    const deps = {
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "branchless-thread",
          workspace_id: "ws-1",
          branch: "main",
          mode: "worktree",
          checkout_state: "branchless",
          pr_number: 42,
          pr_status: "OPEN",
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
        }),
      },
      ciWatcherService: {
        getFreshCache: vi.fn().mockReturnValue(null),
        getEntry: vi.fn().mockReturnValue(null),
        watch,
        refresh: vi.fn(),
      },
      githubService: {
        getCheckRuns,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-checks",
        method: "github.checkStatus",
        params: { threadId: "branchless-thread" },
      }),
      deps,
    );

    expect(response.result).toMatchObject({ aggregate: "no_checks", runs: [] });
    expect(watch).not.toHaveBeenCalled();
    expect(getCheckRuns).not.toHaveBeenCalled();
  });

  it("bootstraps check polling only for named worktree threads", async () => {
    const getCheckRuns = vi.fn().mockResolvedValue({
      aggregate: "passing",
      runs: [],
      fetchedAt: 1,
    });
    const watch = vi.fn();
    const deps = {
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "named-thread",
          workspace_id: "ws-1",
          branch: "feat/named",
          mode: "worktree",
          checkout_state: "named",
          pr_number: 42,
          pr_status: "OPEN",
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
        }),
      },
      ciWatcherService: {
        getFreshCache: vi.fn().mockReturnValue(null),
        getEntry: vi
          .fn()
          .mockReturnValueOnce(null)
          .mockReturnValueOnce({
            branch: "feat/named",
            repoPath: "C:/repo",
          }),
        watch,
        refresh: vi.fn(),
      },
      githubService: {
        getCheckRuns,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-checks",
        method: "github.checkStatus",
        params: { threadId: "named-thread" },
      }),
      deps,
    );

    expect(response.result).toEqual({
      aggregate: "passing",
      runs: [],
      fetchedAt: 1,
    });
    expect(watch).toHaveBeenCalledWith(
      "named-thread",
      42,
      "feat/named",
      "C:/repo",
      { skipInitialFetch: true },
    );
    expect(getCheckRuns).toHaveBeenCalledWith("feat/named", "C:/repo");
  });
});
