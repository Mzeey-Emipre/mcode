import { describe, expect, it, vi } from "vitest";
import type {
  TerminalLaunchSnapshot,
  TerminalResolvedProfile,
  TerminalScope,
  TerminalSessionSnapshot,
} from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import type { TerminalSessionRuntime } from "../terminal-session-runtime.js";
import {
  PreparedTerminalSessionLaunchError,
  TerminalSessionPolicyError,
  TerminalSessionService,
} from "../terminal-session-service.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_SCOPE: TerminalScope = { kind: "workspace", workspaceId: WORKSPACE_ID };
const THREAD_SCOPE: TerminalScope = { kind: "thread", workspaceId: WORKSPACE_ID, threadId: THREAD_ID };
const PROFILE: TerminalResolvedProfile = {
  id: "certified:windows-powershell-7",
  name: "PowerShell",
  executable: "pwsh.exe",
  arguments: ["-NoLogo"],
  source: "certified",
  platform: "windows",
};

function snapshot(
  sessionId: string,
  scope: TerminalScope,
  launch: TerminalLaunchSnapshot,
): TerminalSessionSnapshot {
  return {
    contractVersion: 1,
    sessionId,
    scope,
    state: "running",
    hostGeneration: "3",
    launch,
    createdAt: "2026-08-11T12:00:00.000Z",
    lastCommandSeq: "0",
    lastOutputSeq: "0",
    exit: null,
    tombstone: false,
  };
}

function setup(
  sessionLimit = 20,
  environment: Record<string, string> = { SECRET: "value", PATH: "bin" },
) {
  const sessions = new Map<string, TerminalSessionSnapshot>();
  const runtime = {
    createSession: vi.fn(async (input) => {
      const created = snapshot(input.sessionId, input.scope, input.launch);
      sessions.set(input.sessionId, created);
      return created;
    }),
    close: vi.fn(async ({ sessionId }) => {
      const current = sessions.get(sessionId);
      if (!current) throw new Error("missing");
      const closed = {
        ...current,
        state: "exited" as const,
        exit: { code: 0, signal: null, reason: "user-close" as const },
        tombstone: true,
      };
      sessions.delete(sessionId);
      return closed;
    }),
    getSnapshot: vi.fn((sessionId: string) => sessions.get(sessionId) ?? null),
    discardExitedSession: vi.fn((sessionId: string) => sessions.delete(sessionId)),
    shutdown: vi.fn(async () => undefined),
  } as unknown as TerminalSessionRuntime;
  const settings = getDefaultSettings();
  settings.terminal.behavior.sessionLimit = sessionLimit;
  let settingsListener: ((next: typeof settings) => void) | undefined;
  const liveSettings = { apply: vi.fn() };
  const resolvedProfile: TerminalResolvedProfile = {
    ...PROFILE,
    arguments: [...PROFILE.arguments],
  };
  let nextId = 0;
  const service = new TerminalSessionService({
    runtime,
    profiles: {
      resolveLaunchProfile: vi.fn(async () => ({
        requestedProfileId: "automatic" as const,
        resolvedProfile,
      })),
    },
    settings: {
      get: () => settings,
      on: (_event, listener) => {
        settingsListener = listener;
        return vi.fn();
      },
    },
    liveSettings,
    env: { getEnv: () => environment },
    workspaces: { findById: (id) => id === WORKSPACE_ID ? { id, path: "C:\\workspace" } : null },
    threads: { findById: (id) => id === THREAD_ID ? {
      id,
      workspace_id: WORKSPACE_ID,
      mode: "worktree",
      worktree_path: "C:\\workspace-tree",
    } : null },
    resolveWorkingDir: (_root, _mode, worktreePath) => worktreePath ?? "C:\\workspace",
    hostGeneration: () => "3",
    createSessionId: () => `00000000-0000-4000-8000-${(++nextId).toString().padStart(12, "0")}`,
    validateWorkingDirectory: () => true,
  });
  return {
    service,
    runtime,
    settings,
    sessions,
    liveSettings,
    resolvedProfile,
    emitSettings: () => settingsListener?.(settings),
  };
}

function nonRunningSnapshot(
  state: "starting" | "exited" | "failed",
  input: Parameters<TerminalSessionRuntime["createSession"]>[0],
): TerminalSessionSnapshot {
  const base = snapshot(input.sessionId, input.scope, input.launch);
  if (state === "starting") return { ...base, state };
  return {
    ...base,
    state,
    exit: { code: state === "exited" ? 0 : 1, signal: null, reason: "natural" },
    tombstone: true,
  };
}

describe("TerminalSessionService", () => {
  it("uses one app-wide capacity across workspace and thread scopes", async () => {
    const { service, runtime } = setup(2);
    await service.createSession({ scope: WORKSPACE_SCOPE });
    await service.createSession({ scope: THREAD_SCOPE });

    await expect(service.createSession({ scope: WORKSPACE_SCOPE })).rejects.toMatchObject({
      code: "SLOT_LIMIT_REACHED",
      retry: "NEW_SESSION",
    });
    expect(runtime.createSession).toHaveBeenCalledTimes(2);
  });

  it("reserves capacity while a session is being created", async () => {
    const { service, runtime } = setup(1);
    const createSession = vi.mocked(runtime.createSession);
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const originalCreate = createSession.getMockImplementation();
    createSession.mockImplementationOnce(async (input) => {
      await createGate;
      if (!originalCreate) throw new Error("missing create implementation");
      return originalCreate(input);
    });

    const first = service.createSession({ scope: WORKSPACE_SCOPE });
    await vi.waitFor(() => expect(runtime.createSession).toHaveBeenCalledOnce());
    await expect(service.createSession({ scope: THREAD_SCOPE })).rejects.toMatchObject({
      code: "SLOT_LIMIT_REACHED",
    });
    releaseCreate?.();
    await first;
  });

  it.each(["starting", "exited", "failed"] as const)(
    "rejects and closes a runtime session returned in the %s state",
    async (state) => {
      const { service, runtime, sessions } = setup();
      vi.mocked(runtime.createSession).mockImplementationOnce(async (input) => {
        const invalid = nonRunningSnapshot(state, input);
        sessions.set(input.sessionId, invalid);
        return invalid;
      });

      await expect(service.createSession({ scope: WORKSPACE_SCOPE })).rejects.toThrow();

      expect(runtime.close).toHaveBeenCalledOnce();
      expect(service.listSessions()).toHaveLength(0);
    },
  );

  it("rejects an environment snapshot outside the bounded launch contract", async () => {
    const environment = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "value"]),
    );
    const { service, runtime } = setup(20, environment);

    await expect(service.createSession({ scope: WORKSPACE_SCOPE })).rejects.toMatchObject({
      code: "CONTAINMENT_FAILED",
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("bounds the canonical JSON size of the environment snapshot", async () => {
    const { service, runtime } = setup(20, { VALUE: "\n".repeat(40_000) });

    await expect(service.createSession({ scope: WORKSPACE_SCOPE })).rejects.toMatchObject({
      code: "CONTAINMENT_FAILED",
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("captures immutable launch, working-directory, and environment snapshots", async () => {
    const { service, runtime, resolvedProfile } = setup();
    const created = await service.createSession({ scope: THREAD_SCOPE });
    resolvedProfile.arguments.push("-Mutated");

    expect(created.launch).toEqual({
      requestedProfileId: "automatic",
      resolvedProfile: expect.objectContaining({ arguments: ["-NoLogo"] }),
      scope: THREAD_SCOPE,
      arguments: ["-NoLogo"],
    });
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "C:\\workspace-tree",
      protectedEnv: [
        { name: "PATH", value: "bin" },
        { name: "SECRET", value: "value" },
      ],
    }));
    expect(Object.isFrozen(created.launch)).toBe(true);
    expect(Object.isFrozen(created.launch.arguments)).toBe(true);
  });

  it("keeps exited tombstones at capacity until explicit close", async () => {
    const { service, sessions } = setup(1);
    const exited = await service.createSession({ scope: WORKSPACE_SCOPE });
    sessions.set(exited.sessionId, {
      ...exited,
      state: "exited",
      exit: { code: 0, signal: null, reason: "natural" },
      tombstone: true,
    });

    await expect(service.createSession({ scope: THREAD_SCOPE })).rejects.toMatchObject({
      code: "SLOT_LIMIT_REACHED",
    });
    await service.closeSession(exited.sessionId, "user");
    await expect(service.createSession({ scope: THREAD_SCOPE })).resolves.toMatchObject({
      scope: THREAD_SCOPE,
    });
  });

  it("releases an exited prepared Action from capacity after it retains its result", async () => {
    const { service, sessions, runtime } = setup(1);
    const prepared = await service.createPreparedSession({ scope: THREAD_SCOPE, script: "Write-Output done" });
    sessions.set(prepared.session.sessionId, {
      ...prepared.session,
      state: "exited",
      exit: { code: 0, signal: null, reason: "natural" },
      tombstone: true,
    });

    await expect(service.createPreparedSession({ scope: THREAD_SCOPE, script: "Write-Output again" })).rejects.toMatchObject({
      code: "SLOT_LIMIT_REACHED",
    });
    service.releasePreparedSession(prepared.session.sessionId);

    await expect(service.createPreparedSession({ scope: THREAD_SCOPE, script: "Write-Output again" })).resolves.toMatchObject({
      checkoutPath: "C:\\workspace-tree",
    });
    expect(runtime.discardExitedSession).toHaveBeenCalledWith(prepared.session.sessionId);
  });

  it("retains resolved prepared launch facts when the terminal host rejects creation", async () => {
    const { service, runtime } = setup();
    const hostFailure = new Error("host unavailable");
    vi.mocked(runtime.createSession).mockRejectedValueOnce(hostFailure);

    const failure = await service.createPreparedSession({
      scope: THREAD_SCOPE,
      script: "Write-Output failed",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparedTerminalSessionLaunchError);
    expect(failure).toMatchObject({
      original: hostFailure,
      plan: {
        checkoutPath: "C:\\workspace-tree",
        terminal: {
          executable: "pwsh.exe",
          arguments: ["-NoLogo", "-NoLogo", "-NonInteractive", "-Command", "Write-Output failed"],
        },
        environmentNames: ["PATH", "SECRET"],
      },
    });
  });

  it("replaces an exited tombstone only after the new session is running", async () => {
    const { service, sessions } = setup(1);
    const exited = await service.createSession({ scope: WORKSPACE_SCOPE });
    sessions.set(exited.sessionId, {
      ...exited,
      state: "exited",
      exit: { code: 0, signal: null, reason: "natural" },
      tombstone: true,
    });

    const replacement = await service.createSession({
      scope: WORKSPACE_SCOPE,
      replacesSessionId: exited.sessionId,
    });

    expect(replacement.sessionId).not.toBe(exited.sessionId);
    expect(service.listSessions()).toEqual([replacement]);
  });

  it("keeps the old tombstone when replacement creation fails", async () => {
    const { service, runtime, sessions } = setup(1);
    const exited = await service.createSession({ scope: WORKSPACE_SCOPE });
    sessions.set(exited.sessionId, {
      ...exited,
      state: "exited",
      exit: { code: 0, signal: null, reason: "natural" },
      tombstone: true,
    });
    vi.mocked(runtime.createSession).mockRejectedValueOnce(new Error("replacement failed"));

    await expect(service.createSession({
      scope: WORKSPACE_SCOPE,
      replacesSessionId: exited.sessionId,
    })).rejects.toThrow("replacement failed");

    expect(service.listSessions()).toEqual([
      expect.objectContaining({ sessionId: exited.sessionId, state: "exited" }),
    ]);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("rolls back a replacement when removing the old tombstone fails", async () => {
    const { service, runtime, sessions } = setup(1);
    const exited = await service.createSession({ scope: WORKSPACE_SCOPE });
    sessions.set(exited.sessionId, {
      ...exited,
      state: "exited",
      exit: { code: 0, signal: null, reason: "natural" },
      tombstone: true,
    });
    vi.mocked(runtime.close).mockRejectedValueOnce(new Error("close failed"));

    await expect(service.createSession({
      scope: WORKSPACE_SCOPE,
      replacesSessionId: exited.sessionId,
    })).rejects.toThrow("close failed");

    expect(service.listSessions()).toEqual([expect.objectContaining({ sessionId: exited.sessionId })]);
    expect(runtime.close).toHaveBeenCalledTimes(2);
  });

  it("rejects a thread whose workspace does not match the scope", async () => {
    const { service, runtime } = setup();

    await expect(service.createSession({
      scope: { ...THREAD_SCOPE, workspaceId: "00000000-0000-4000-8000-000000000009" },
    })).rejects.toBeInstanceOf(TerminalSessionPolicyError);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("closes all matching sessions through the runtime seam", async () => {
    const { service, runtime } = setup();
    await service.createSession({ scope: WORKSPACE_SCOPE });
    await service.createSession({ scope: THREAD_SCOPE });

    await service.closeScope(THREAD_SCOPE, "scope-reset");

    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(service.listSessions()).toHaveLength(1);
    expect(service.listSessions()[0].scope).toEqual(WORKSPACE_SCOPE);
  });

  it("closes workspace sessions and their child thread sessions", async () => {
    const { service, runtime } = setup();
    await service.createSession({ scope: WORKSPACE_SCOPE });
    await service.createSession({ scope: THREAD_SCOPE });

    await service.closeScope(WORKSPACE_SCOPE, "workspace-delete");

    expect(runtime.close).toHaveBeenCalledTimes(2);
    expect(service.listSessions()).toHaveLength(0);
  });

  it("deduplicates concurrent close requests", async () => {
    const { service, runtime } = setup();
    const created = await service.createSession({ scope: WORKSPACE_SCOPE });
    const originalClose = vi.mocked(runtime.close).getMockImplementation();
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    vi.mocked(runtime.close).mockImplementationOnce(async (input) => {
      await closeGate;
      if (!originalClose) throw new Error("missing close implementation");
      return originalClose(input);
    });

    const first = service.closeSession(created.sessionId, "scope-reset");
    const second = service.closeSession(created.sessionId, "scope-reset");
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    releaseClose?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("applies changed live-safe settings without restarting or recreating sessions", () => {
    const { emitSettings, liveSettings, runtime, settings } = setup();
    liveSettings.apply.mockClear();
    settings.terminal.behavior.scrollback = 500;

    emitSettings();

    expect(liveSettings.apply).toHaveBeenCalledWith({
      scrollback: 500,
      flowControl: settings.terminal.flowControl,
    });
    const applied = liveSettings.apply.mock.calls[0]?.[0];
    settings.terminal.flowControl.serverHighBytes += 1;
    expect(applied?.flowControl.serverHighBytes).not.toBe(
      settings.terminal.flowControl.serverHighBytes,
    );
    expect(Object.isFrozen(applied?.flowControl)).toBe(true);
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
  });
});
