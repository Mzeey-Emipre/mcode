import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  type Settings,
  type TerminalProfileReference,
  type TerminalResolvedProfile,
  type TerminalScope,
} from "@mcode/contracts";
import { killProcessTree } from "../../../runtime/process/containment/process-kill.js";
import {
  TerminalReplayBuffer,
  replayBytesForScrollback,
} from "../sessions/terminal-replay-buffer.js";
import {
  resolveTerminalScope,
  TerminalScopeResolutionError,
  type TerminalScopeResolverDependencies,
} from "../sessions/terminal-scope.js";
import {
  TerminalProfileNotFoundError,
  TerminalProfileUnavailableError,
} from "../profiles/terminal-profile-service.js";
import type { PtyPidRegistry } from "../host/pty-pid-registry.js";

const COMMAND_OUTPUT_CHUNK_MAX_BYTES = 65_536;

/** Resolves the active Terminal profile for a one-shot command. */
export interface TerminalCommandProfileResolver {
  resolveLaunchProfile(input: {
    readonly workspaceId?: string;
    readonly requestedProfileId?: TerminalProfileReference;
  }): Promise<{
    readonly requestedProfileId: TerminalProfileReference;
    readonly resolvedProfile: TerminalResolvedProfile;
  }>;
}

/** Minimal child-process surface used by the noninteractive Terminal command seam. */
export interface TerminalCommandProcess {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

/** Immutable Terminal command details captured before a child process starts. */
export interface TerminalCommandLaunchSnapshot {
  readonly checkoutPath: string | null;
  readonly terminal: {
    readonly executable: string;
    readonly arguments: readonly string[];
  } | null;
}

/** Terminal result produced after a one-shot command exits or is contained. */
export type TerminalCommandCompletion =
  | {
    readonly kind: "exited";
    readonly exitCode: number | null;
    readonly output: string;
    readonly outputTruncated: boolean;
  }
  | {
    readonly kind: "launch_failure";
    readonly output: string;
    readonly outputTruncated: boolean;
  }
  | {
    readonly kind: "timeout";
    readonly output: string;
    readonly outputTruncated: boolean;
  }
  | {
    readonly kind: "containment_failure";
    readonly output: string;
    readonly outputTruncated: boolean;
  };

/** Result of closing a one-shot command and verifying its process tree. */
export type TerminalCommandCloseResult =
  | { readonly kind: "contained" }
  | { readonly kind: "containment_failure" };

/** Prepared one-shot command that starts only after its caller records the launch snapshot. */
export interface PreparedTerminalCommand {
  readonly snapshot: TerminalCommandLaunchSnapshot;
  start(): Promise<TerminalCommandCompletion>;
  close(): Promise<TerminalCommandCloseResult>;
  waitForRelease(): Promise<void>;
}

/** Terminal preparation result that never exposes environment values. */
export type TerminalCommandPreparation =
  | { readonly kind: "ready"; readonly command: PreparedTerminalCommand }
  | { readonly kind: "configuration"; readonly snapshot: TerminalCommandLaunchSnapshot; readonly output: string }
  | { readonly kind: "unavailable"; readonly snapshot: TerminalCommandLaunchSnapshot; readonly output: string };

/** Injectable dependencies for isolated one-shot Terminal command execution. */
export interface TerminalCommandServiceDependencies extends TerminalScopeResolverDependencies {
  readonly profiles: TerminalCommandProfileResolver;
  readonly env: { getEnv(): Record<string, string> };
  readonly settings: { get(): Settings };
  readonly spawn?: (
    executable: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly stdio: readonly ["ignore", "pipe", "pipe"];
      readonly shell: false;
      readonly windowsHide: boolean;
      readonly detached: boolean;
    },
  ) => TerminalCommandProcess;
  readonly killProcessTree?: (pid: number) => Promise<void>;
  readonly pidRegistry?: Pick<PtyPidRegistry, "register" | "deregister">;
  readonly createCommandId?: () => string;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
}

/** Executes bounded noninteractive shell commands owned by the Terminal feature. */
export class TerminalCommandService {
  private readonly spawn: NonNullable<TerminalCommandServiceDependencies["spawn"]>;
  private readonly kill: (pid: number) => Promise<void>;
  private readonly schedule: NonNullable<TerminalCommandServiceDependencies["setTimeout"]>;
  private readonly cancel: NonNullable<TerminalCommandServiceDependencies["clearTimeout"]>;

  constructor(private readonly deps: TerminalCommandServiceDependencies) {
    this.spawn = deps.spawn ?? spawnTerminalCommand;
    this.kill = deps.killProcessTree ?? killProcessTree;
    this.schedule = deps.setTimeout ?? setTimeout;
    this.cancel = deps.clearTimeout ?? clearTimeout;
  }

  /** Resolves a profile and checkout into a command that the caller can start later. */
  async prepare(input: {
    readonly scope: TerminalScope;
    readonly script: string;
    readonly timeoutMs: number;
    readonly outputMaxBytes?: number;
  }): Promise<TerminalCommandPreparation> {
    let checkoutPath: string;
    try {
      checkoutPath = resolveTerminalScope(input.scope, this.deps);
    } catch (error) {
      if (error instanceof TerminalScopeResolutionError) {
        return unavailablePreparation("The current Thread checkout is unavailable");
      }
      throw error;
    }

    let resolved: Awaited<ReturnType<TerminalCommandProfileResolver["resolveLaunchProfile"]>>;
    try {
      resolved = await this.deps.profiles.resolveLaunchProfile({ workspaceId: input.scope.workspaceId });
    } catch (error) {
      if (error instanceof TerminalProfileNotFoundError || error instanceof TerminalProfileUnavailableError) {
        return unavailablePreparation("The current Terminal profile is unavailable", checkoutPath);
      }
      throw error;
    }
    const launch = noninteractiveLaunch(resolved.resolvedProfile, input.script);
    if (!launch) {
      return {
        kind: "configuration",
        snapshot: Object.freeze({
          checkoutPath,
          terminal: Object.freeze({
            executable: resolved.resolvedProfile.executable,
            arguments: Object.freeze([...resolved.resolvedProfile.arguments]),
          }),
        }),
        output: "The current Terminal profile does not support noninteractive Setup commands",
      };
    }
    const snapshot: TerminalCommandLaunchSnapshot = Object.freeze({
      checkoutPath,
      terminal: Object.freeze({
        executable: launch.executable,
        arguments: Object.freeze([...launch.arguments]),
      }),
    });
    return {
      kind: "ready",
      command: this.createCommand(
        snapshot,
        input.timeoutMs,
        Math.min(
          replayBytesForScrollback(this.deps.settings.get().terminal.behavior.scrollback),
          input.outputMaxBytes ?? Number.POSITIVE_INFINITY,
        ),
      ),
    };
  }

  private createCommand(
    snapshot: TerminalCommandLaunchSnapshot,
    timeoutMs: number,
    outputMaxBytes: number,
  ): PreparedTerminalCommand {
    const terminal = snapshot.terminal;
    const checkoutPath = snapshot.checkoutPath;
    const capture = new TerminalOutputCapture(outputMaxBytes);
    let child: TerminalCommandProcess | null = null;
    let startPromise: Promise<TerminalCommandCompletion> | null = null;
    let containmentPromise: Promise<TerminalCommandCloseResult> | null = null;
    let completionResolve: ((result: TerminalCommandCompletion) => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let completionSettled = false;
    let containmentInFlight = false;
    let containmentFailed = false;
    let releaseResolve!: () => void;
    let released = false;
    let closedBeforeStart = false;
    let registeredCommandId: string | null = null;
    const releasedPromise = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const release = (): void => {
      if (released) return;
      released = true;
      releaseResolve();
    };
    const deregister = (): void => {
      if (!registeredCommandId) return;
      this.deps.pidRegistry?.deregister(registeredCommandId);
      registeredCommandId = null;
    };
    const settle = (result: TerminalCommandCompletion): void => {
      if (completionSettled || !completionResolve) return;
      completionSettled = true;
      if (timeout) this.cancel(timeout);
      completionResolve(result);
    };
    const close = (): Promise<TerminalCommandCloseResult> => {
      if (released) {
        return Promise.resolve({ kind: "contained" });
      }
      if (!child) {
        closedBeforeStart = true;
        release();
        return Promise.resolve({ kind: "contained" });
      }
      if (containmentInFlight && containmentPromise) {
        return containmentPromise;
      }
      if (typeof child.pid !== "number" || child.pid <= 0) {
        containmentFailed = true;
        settle({ kind: "containment_failure", ...capture.result() });
        return Promise.resolve({ kind: "containment_failure" });
      }
      const pid = child.pid;
      containmentInFlight = true;
      containmentPromise = new Promise((resolve) => {
        let closeSettled = false;
        const finish = (result: TerminalCommandCloseResult): void => {
          if (closeSettled) return;
          closeSettled = true;
          containmentInFlight = false;
          if (result.kind === "contained") {
            containmentFailed = false;
            deregister();
            release();
            settle(timedOut
              ? { kind: "timeout", ...capture.result() }
              : { kind: "launch_failure", ...capture.result() });
          } else {
            containmentFailed = true;
            settle({ kind: "containment_failure", ...capture.result() });
          }
          resolve(result);
        };
        void Promise.resolve().then(() => this.kill(pid)).then(
          () => finish({ kind: "contained" }),
          () => finish({ kind: "containment_failure" }),
        );
      });
      return containmentPromise;
    };
    const spawnChild = (): TerminalCommandProcess | null => {
      if (!terminal || !checkoutPath) return null;
      try {
        return this.spawn(terminal.executable, terminal.arguments, {
          cwd: checkoutPath,
          env: this.deps.env.getEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch {
        return null;
      }
    };
    const registerChild = (process: TerminalCommandProcess): void => {
      if (typeof process.pid !== "number" || process.pid <= 0 || !this.deps.pidRegistry) return;
      registeredCommandId = `terminal-command:${this.deps.createCommandId?.() ?? randomUUID()}`;
      this.deps.pidRegistry.register(registeredCommandId, process.pid, terminal!.executable);
    };
    const observeChild = (process: TerminalCommandProcess): void => {
      if (!process.stdout || !process.stderr) {
        void close();
        return;
      }
      process.stdout.on("data", (chunk: Uint8Array) => capture.append(chunk));
      process.stderr.on("data", (chunk: Uint8Array) => capture.append(chunk));
      timeout = this.schedule(() => {
        timedOut = true;
        void close();
      }, timeoutMs);
      process.once("error", () => {
        if (containmentInFlight || containmentFailed) return;
        deregister();
        release();
        settle(timedOut
          ? { kind: "timeout", ...capture.result() }
          : { kind: "launch_failure", ...capture.result() });
      });
      process.once("close", (exitCode) => {
        if (containmentInFlight || containmentFailed) return;
        deregister();
        release();
        settle(timedOut
          ? { kind: "timeout", ...capture.result() }
          : { kind: "exited", exitCode, ...capture.result() });
      });
    };

    return Object.freeze({
      snapshot,
      start: () => {
        if (startPromise) return startPromise;
        if (closedBeforeStart) {
          return Promise.resolve<TerminalCommandCompletion>({ kind: "launch_failure", ...capture.result() });
        }
        startPromise = new Promise<TerminalCommandCompletion>((resolve) => { completionResolve = resolve; });
        child = spawnChild();
        if (!child) {
          settle({ kind: "launch_failure", ...capture.result() });
          release();
          return startPromise;
        }
        registerChild(child);
        observeChild(child);
        return startPromise;
      },
      close,
      waitForRelease: () => releasedPromise,
    });
  }

}

/** Builds profile-specific noninteractive arguments without opening an interactive shell. */
export function noninteractiveLaunch(
  profile: TerminalResolvedProfile,
  script: string,
): { readonly executable: string; readonly arguments: readonly string[] } | null {
  const executable = basename(profile.executable).toLowerCase();
  const arguments_ = [...profile.arguments];
  if (isPowerShell(executable)) {
    return { executable: profile.executable, arguments: [...arguments_, "-NoLogo", "-NonInteractive", "-Command", script] };
  }
  if (isWindowsCommandShell(executable)) {
    return { executable: profile.executable, arguments: [...arguments_, "/d", "/s", "/c", script] };
  }
  if (isPosixShell(executable)) {
    return { executable: profile.executable, arguments: [...arguments_, "-lc", script] };
  }
  if (isWindowsSubsystemForLinux(executable)) {
    return { executable: profile.executable, arguments: [...arguments_, "--exec", "sh", "-lc", script] };
  }
  return null;
}

function isPowerShell(executable: string): boolean {
  return ["powershell.exe", "powershell", "pwsh.exe", "pwsh"].includes(executable);
}

function isWindowsCommandShell(executable: string): boolean {
  return executable === "cmd.exe" || executable === "cmd";
}

function isPosixShell(executable: string): boolean {
  return ["bash", "bash.exe", "zsh", "zsh.exe", "sh", "sh.exe"].includes(executable);
}

function isWindowsSubsystemForLinux(executable: string): boolean {
  return executable === "wsl" || executable === "wsl.exe";
}

function unavailablePreparation(output: string, checkoutPath: string | null = null): TerminalCommandPreparation {
  return {
    kind: "unavailable",
    snapshot: Object.freeze({ checkoutPath, terminal: null }),
    output,
  };
}

function spawnTerminalCommand(
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly stdio: readonly ["ignore", "pipe", "pipe"];
    readonly shell: false;
    readonly windowsHide: boolean;
    readonly detached: boolean;
  },
): TerminalCommandProcess {
  return spawn(executable, [...arguments_], { ...options, stdio: [...options.stdio] }) as ChildProcess;
}

class TerminalOutputCapture {
  private readonly replay: TerminalReplayBuffer;
  private sequence = 0n;

  constructor(capacityBytes: number) {
    this.replay = new TerminalReplayBuffer(capacityBytes);
  }

  append(chunk: Uint8Array): void {
    for (let offset = 0; offset < chunk.byteLength; offset += COMMAND_OUTPUT_CHUNK_MAX_BYTES) {
      this.sequence += 1n;
      this.replay.append(
        this.sequence,
        chunk.slice(offset, offset + COMMAND_OUTPUT_CHUNK_MAX_BYTES),
      );
    }
  }

  result(): { readonly output: string; readonly outputTruncated: boolean } {
    if (this.sequence === 0n) return { output: "", outputTruncated: false };
    const hydrated = this.replay.hydrate({
      hydrationId: "00000000-0000-4000-8000-000000000000",
      requestedAfterSeq: 0n,
      checkpointSeq: null,
    });
    const output = Buffer.concat(hydrated.output.map((chunk) => Buffer.from(chunk.data))).toString("utf8");
    return { output, outputTruncated: hydrated.descriptor.gap !== null };
  }
}
