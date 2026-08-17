import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  TERMINAL_V1_METHODS,
  TerminalLaunchSnapshotSchema,
  TerminalSessionSnapshotSchema,
  TerminalScopeSchema,
  TerminalU64Schema,
  type Settings,
  type TerminalLaunchSnapshot,
  type TerminalProfileReference,
  type TerminalResolvedProfile,
  type TerminalSettings,
  type TerminalScope,
  type TerminalSessionSnapshot,
} from "@mcode/contracts";
import type { TerminalSessionRuntime } from "./terminal-session-runtime.js";

/** Profile-resolution seam consumed by Terminal product policy. */
export interface TerminalSessionProfileResolver {
  resolveLaunchProfile(input: {
    readonly workspaceId?: string;
    readonly requestedProfileId?: TerminalProfileReference;
  }): Promise<{
    readonly requestedProfileId: TerminalProfileReference;
    readonly resolvedProfile: TerminalResolvedProfile;
  }>;
}

/** Validated settings source consumed by Terminal product policy. */
export interface TerminalSessionSettingsSource {
  get(): Settings;
  on(event: "change", listener: (next: Settings) => void): () => void;
}

/** Applies settings that do not require replacing a PTY. */
export interface TerminalLiveSettingsSink {
  apply(settings: {
    readonly scrollback: number;
    readonly flowControl: TerminalSettings["flowControl"];
  }): void;
}

/** Product and runtime seams required by the Terminal session service. */
export interface TerminalSessionServiceDependencies {
  readonly runtime: TerminalSessionRuntime;
  readonly profiles: TerminalSessionProfileResolver;
  readonly settings: TerminalSessionSettingsSource;
  readonly liveSettings: TerminalLiveSettingsSink;
  readonly env: { getEnv(): Record<string, string> };
  readonly workspaces: { findById(id: string): { readonly id: string; readonly path: string } | null };
  readonly threads: {
    findById(id: string): {
      readonly id: string;
      readonly workspace_id: string;
      readonly mode: string;
      readonly worktree_path: string | null;
    } | null;
  };
  readonly resolveWorkingDir: (workspacePath: string, mode: string, worktreePath: string | null) => string;
  readonly hostGeneration: () => string;
  readonly createSessionId?: () => string;
  readonly validateWorkingDirectory?: (path: string) => boolean;
}

/** Typed product-policy failure raised before a Terminal runtime mutation. */
export class TerminalSessionPolicyError extends Error {
  readonly retry: "NEW_SESSION";
  readonly correlationId: string;

  constructor(readonly code: "INVALID_SCOPE" | "SLOT_LIMIT_REACHED" | "SESSION_NOT_FOUND" | "CONTAINMENT_FAILED") {
    super(POLICY_MESSAGES[code]);
    this.name = "TerminalSessionPolicyError";
    this.retry = "NEW_SESSION";
    this.correlationId = `corr-${randomUUID()}`;
  }
}

const POLICY_MESSAGES = {
  INVALID_SCOPE: "The Terminal scope is invalid",
  SLOT_LIMIT_REACHED: "The app-wide Terminal session limit is reached",
  SESSION_NOT_FOUND: "The Terminal session was not found",
  CONTAINMENT_FAILED: "The Terminal process environment exceeds the safe launch boundary",
} as const;

const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_JSON_BYTES = 65_536;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Applies product policy before work enters the deep Terminal session runtime. */
export class TerminalSessionService {
  private readonly sessionIds = new Set<string>();
  private readonly closing = new Map<string, Promise<TerminalSessionSnapshot>>();
  private reservations = 0;
  private readonly createSessionId: () => string;
  private readonly validateWorkingDirectory: (path: string) => boolean;
  private readonly unsubscribeSettings: () => void;
  private lastLiveSettingsKey = "";

  constructor(private readonly deps: TerminalSessionServiceDependencies) {
    this.createSessionId = deps.createSessionId ?? randomUUID;
    this.validateWorkingDirectory = deps.validateWorkingDirectory ?? isExistingAbsoluteDirectory;
    this.applyLiveSettings(deps.settings.get());
    this.unsubscribeSettings = deps.settings.on("change", (settings) => this.applyLiveSettings(settings));
  }

  /** Creates one session after scope, profile, capacity, and snapshot checks pass. */
  async createSession(input: {
    readonly scope: TerminalScope;
    readonly requestedProfileId?: TerminalProfileReference;
    readonly replacesSessionId?: string;
  }): Promise<TerminalSessionSnapshot> {
    const parsed = TERMINAL_V1_METHODS["terminal.session.create"].params.parse(input) as typeof input;
    const cwd = this.resolveScope(parsed.scope);
    const replacement = parsed.replacesSessionId
      ? this.requireTrackedSnapshot(parsed.replacesSessionId)
      : null;
    if (replacement && replacement.state !== "exited" && replacement.state !== "failed") {
      throw new TerminalSessionPolicyError("SESSION_NOT_FOUND");
    }
    const replacementCredit = replacement ? 1 : 0;
    const limit = this.deps.settings.get().terminal.behavior.sessionLimit;
    if (this.sessionIds.size + this.reservations - replacementCredit >= limit) {
      throw new TerminalSessionPolicyError("SLOT_LIMIT_REACHED");
    }
    this.reservations += 1;
    try {
      const profile = await this.deps.profiles.resolveLaunchProfile({
        workspaceId: parsed.scope.workspaceId,
        requestedProfileId: parsed.requestedProfileId,
      });
      const launch = freezeLaunchSnapshot({
        requestedProfileId: profile.requestedProfileId,
        resolvedProfile: profile.resolvedProfile,
        scope: parsed.scope,
        arguments: profile.resolvedProfile.arguments,
      });
      const sessionId = this.createSessionId();
      const hostGeneration = TerminalU64Schema().parse(this.deps.hostGeneration());
      const protectedEnv = snapshotEnvironment(this.deps.env.getEnv());
      const created = await this.deps.runtime.createSession({
        sessionId,
        scope: parsed.scope,
        launch,
        hostGeneration,
        cwd,
        protectedEnv: Object.freeze(protectedEnv),
      });
      this.sessionIds.add(sessionId);
      let validated: TerminalSessionSnapshot;
      try {
        validated = freezeSessionSnapshot(
          TERMINAL_V1_METHODS["terminal.session.create"].result.parse(created),
        );
      } catch (error) {
        await this.rollbackCreatedSession(sessionId);
        throw error;
      }
      if (replacement) {
        try {
          await this.closeSession(replacement.sessionId, "user");
        } catch (error) {
          await this.rollbackCreatedSession(sessionId);
          throw error;
        }
      }
      return validated;
    } finally {
      this.reservations -= 1;
    }
  }

  /** Lists tracked runtime snapshots in creation order, with an optional scope filter. */
  listSessions(scope?: TerminalScope): TerminalSessionSnapshot[] {
    const parsedScope = scope ? TerminalScopeSchema().parse(scope) : undefined;
    const sessions: TerminalSessionSnapshot[] = [];
    for (const sessionId of this.sessionIds) {
      const current = this.deps.runtime.getSnapshot(sessionId);
      if (!current) {
        this.sessionIds.delete(sessionId);
        continue;
      }
      if (!parsedScope || scopesEqual(current.scope, parsedScope)) {
        sessions.push(freezeSessionSnapshot(TerminalSessionSnapshotSchema().parse(current)));
      }
    }
    return sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Closes one tracked session and releases its app-wide capacity slot. */
  async closeSession(
    sessionId: string,
    reason: "user" | "scope-reset" | "workspace-delete" | "app-shutdown",
  ): Promise<TerminalSessionSnapshot> {
    const existingClose = this.closing.get(sessionId);
    if (existingClose) return existingClose;
    this.requireTrackedSnapshot(sessionId);
    const close = this.performClose(sessionId, reason);
    this.closing.set(sessionId, close);
    try {
      return await close;
    } finally {
      this.closing.delete(sessionId);
    }
  }

  /** Closes a thread scope or every session owned by a workspace scope. */
  async closeScope(
    scope: TerminalScope,
    reason: "scope-reset" | "workspace-delete",
  ): Promise<void> {
    const parsed = TerminalScopeSchema().parse(scope);
    const matching = this.listSessions().filter((session) => scopeContains(parsed, session.scope));
    await Promise.all(matching.map((session) => this.closeSession(session.sessionId, reason)));
  }

  /** Releases the settings listener without changing runtime session state. */
  dispose(): void {
    this.unsubscribeSettings();
  }

  private resolveScope(scope: TerminalScope): string {
    const parsed = TerminalScopeSchema().parse(scope);
    const workspace = this.deps.workspaces.findById(parsed.workspaceId);
    if (!workspace) throw new TerminalSessionPolicyError("INVALID_SCOPE");
    let cwd = workspace.path;
    if (parsed.kind === "thread") {
      const thread = this.deps.threads.findById(parsed.threadId);
      if (!thread || thread.workspace_id !== parsed.workspaceId) {
        throw new TerminalSessionPolicyError("INVALID_SCOPE");
      }
      cwd = this.deps.resolveWorkingDir(workspace.path, thread.mode, thread.worktree_path);
    }
    if (!this.validateWorkingDirectory(cwd)) {
      throw new TerminalSessionPolicyError("INVALID_SCOPE");
    }
    return cwd;
  }

  private requireTrackedSnapshot(sessionId: string): TerminalSessionSnapshot {
    const current = this.sessionIds.has(sessionId) ? this.deps.runtime.getSnapshot(sessionId) : null;
    if (!current) throw new TerminalSessionPolicyError("SESSION_NOT_FOUND");
    return current;
  }

  private applyLiveSettings(settings: Settings): void {
    const liveSettings = Object.freeze({
      scrollback: settings.terminal.behavior.scrollback,
      flowControl: Object.freeze({ ...settings.terminal.flowControl }),
    });
    const key = JSON.stringify(liveSettings);
    if (key === this.lastLiveSettingsKey) return;
    this.lastLiveSettingsKey = key;
    this.deps.liveSettings.apply(liveSettings);
  }

  private async performClose(
    sessionId: string,
    reason: "user" | "scope-reset" | "workspace-delete" | "app-shutdown",
  ): Promise<TerminalSessionSnapshot> {
    const closed = await this.deps.runtime.close({ sessionId, reason });
    const validated = freezeSessionSnapshot(TerminalSessionSnapshotSchema().parse(closed));
    this.sessionIds.delete(sessionId);
    return validated;
  }

  private async rollbackCreatedSession(sessionId: string): Promise<void> {
    try {
      await this.closeSession(sessionId, "user");
    } catch {
      // Keep the session tracked so list and explicit close can reconcile a failed compensation.
    }
  }
}

function scopesEqual(left: TerminalScope, right: TerminalScope): boolean {
  return left.kind === right.kind
    && left.workspaceId === right.workspaceId
    && (left.kind === "workspace" || (right.kind === "thread" && left.threadId === right.threadId));
}

function scopeContains(container: TerminalScope, candidate: TerminalScope): boolean {
  if (container.kind === "workspace") return container.workspaceId === candidate.workspaceId;
  return scopesEqual(container, candidate);
}

function isExistingAbsoluteDirectory(path: string): boolean {
  if (!isAbsolute(path) || !existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function snapshotEnvironment(env: Record<string, string>): ReadonlyArray<Readonly<{ name: string; value: string }>> {
  const entries = Object.entries(env).filter(([name, value]) =>
    SAFE_ENVIRONMENT_NAME.test(name) && typeof value === "string",
  );
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new TerminalSessionPolicyError("CONTAINMENT_FAILED");
  }
  const snapshot = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => Object.freeze({ name, value }));
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_ENVIRONMENT_JSON_BYTES) {
    throw new TerminalSessionPolicyError("CONTAINMENT_FAILED");
  }
  return Object.freeze(snapshot);
}

function freezeLaunchSnapshot(input: TerminalLaunchSnapshot): TerminalLaunchSnapshot {
  const parsed = TerminalLaunchSnapshotSchema().parse(input);
  const snapshot: TerminalLaunchSnapshot = {
    requestedProfileId: parsed.requestedProfileId,
    resolvedProfile: Object.freeze({
      ...parsed.resolvedProfile,
      arguments: Object.freeze([...parsed.resolvedProfile.arguments]),
    }) as TerminalResolvedProfile,
    scope: Object.freeze({ ...parsed.scope }),
    arguments: Object.freeze([...parsed.arguments]) as unknown as string[],
  };
  return Object.freeze(snapshot) as TerminalLaunchSnapshot;
}

function freezeSessionSnapshot(input: TerminalSessionSnapshot): TerminalSessionSnapshot {
  return Object.freeze({
    ...input,
    scope: Object.freeze({ ...input.scope }),
    launch: freezeLaunchSnapshot(input.launch),
    exit: input.exit ? Object.freeze({ ...input.exit }) : null,
  });
}
