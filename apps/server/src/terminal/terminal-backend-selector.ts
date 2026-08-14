import { injectable } from "tsyringe";
import { LegacyTerminalBackend } from "./legacy/legacy-terminal-backend.js";
import {
  TerminalBackend,
  type TerminalBackendSender,
  type TerminalReattachResult,
} from "./terminal-backend.js";
import type { WebSocket } from "ws";

/** Selects one immutable Terminal backend before the server accepts requests. */
@injectable()
export class TerminalBackendSelector extends TerminalBackend {
  private readonly legacyBackend: LegacyTerminalBackend;
  private readonly allowReleaseTestFallback: boolean;
  private readonly modernBackend?: TerminalBackend;
  private selectedBackend: TerminalBackend;
  private releaseTestHostPid?: number;
  private startupPromise: Promise<void> | null = null;
  private modernShutdownPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    legacyBackend: LegacyTerminalBackend,
    modernBackend?: TerminalBackend,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    super();
    this.legacyBackend = legacyBackend;
    this.allowReleaseTestFallback =
      env.MCODE_TERMINAL_RELEASE_TEST === "1" &&
      env.MCODE_TERMINAL_BACKEND === "modern";
    this.selectedBackend = env.MCODE_TERMINAL_BACKEND === "modern" && modernBackend
      ? modernBackend
      : legacyBackend;
    this.modernBackend = modernBackend;
    if (this.selectedBackend === modernBackend) {
      const startable = modernBackend as TerminalBackend & {
        whenStarted?: () => Promise<unknown>;
      };
      this.startupPromise = startable.whenStarted
        ? startable.whenStarted().then(() => undefined)
        : Promise.resolve();
    }
  }

  /** Returns the Terminal backend selected for this server boot. */
  getSelectedBackend(): TerminalBackend {
    return this.selectedBackend;
  }

  /** Waits for the protected modern host and falls back once before serving. */
  async waitForStartup(timeoutMs = 5_000): Promise<void> {
    if (!this.startupPromise) return;
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Terminal host startup timed out")), timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([this.startupPromise, timeout]);
    } catch (error) {
      if (!this.allowReleaseTestFallback) {
        this.startupPromise = null;
        throw error;
      }
      const modernCapabilities = this.modernBackend?.capabilities();
      if (modernCapabilities?.backend === "modern") {
        this.releaseTestHostPid = modernCapabilities.releaseTest?.hostPid;
      }
      this.disposeModernBackend();
      this.selectedBackend = this.legacyBackend;
      this.startupPromise = null;
    }
  }

  capabilities() {
    const capabilities = this.selectedBackend.capabilities();
    if (this.selectedBackend !== this.legacyBackend || this.releaseTestHostPid === undefined) {
      return capabilities;
    }
    return { ...capabilities, releaseTest: { hostPid: this.releaseTestHostPid } };
  }
  setSender(sender: TerminalBackendSender): void {
    if (this.selectedBackend === this.legacyBackend) {
      this.legacyBackend.setSender(sender);
      return;
    }
    this.legacyBackend.setSender(sender);
    this.selectedBackend.setSender(sender);
  }
  create(scopeId: string) { return this.selectedBackend.create(scopeId); }
  pause(ptyId: string): void { this.selectedBackend.pause(ptyId); }
  resume(ptyId: string): void { this.selectedBackend.resume(ptyId); }
  onBufferedAmountTick(bufferedAmount: number): void { this.selectedBackend.onBufferedAmountTick(bufferedAmount); }
  write(ptyId: string, data: string): void { this.selectedBackend.write(ptyId, data); }
  resize(ptyId: string, cols: number, rows: number): void { this.selectedBackend.resize(ptyId, cols, rows); }
  kill(ptyId: string, reason?: "user-requested-process-tree-close" | "app-shutdown"): Promise<void> { return this.selectedBackend.kill(ptyId, reason); }
  killByThread(threadId: string): Promise<void> { return this.selectedBackend.killByThread(threadId); }
  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      let failure: unknown;
      if (this.selectedBackend === this.legacyBackend && this.modernShutdownPromise) {
        try {
          await this.modernShutdownPromise;
        } catch (error) {
          failure = error;
        }
      }
      try {
        await this.selectedBackend.shutdown();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    })();
    return this.shutdownPromise;
  }
  setGracefulKill(enabled: boolean): void { this.selectedBackend.setGracefulKill(enabled); }
  reattach(ptyId: string, lastSeq: number, cold?: boolean): TerminalReattachResult { return this.selectedBackend.reattach(ptyId, lastSeq, cold); }
  checkpoint(ptyId: string, seq: number, data: string) { return this.selectedBackend.checkpoint(ptyId, seq, data); }
  listActiveSessions() { return this.selectedBackend.listActiveSessions(); }
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> { return this.selectedBackend.hasChildren(ptyId); }
  routeV1(method: string, params: unknown, client: WebSocket): Promise<unknown> { return this.selectedBackend.routeV1(method, params, client); }
  handleV1Frame(client: WebSocket, bytes: Uint8Array): Promise<void> { return this.selectedBackend.handleV1Frame(client, bytes); }
  disconnectClient(client: WebSocket): void { this.selectedBackend.disconnectClient(client); }

  private disposeModernBackend(): Promise<void> {
    if (!this.modernBackend || this.modernShutdownPromise) {
      return this.modernShutdownPromise ?? Promise.resolve();
    }
    this.modernShutdownPromise = Promise.resolve().then(() => this.modernBackend!.shutdown());
    void this.modernShutdownPromise.catch(() => undefined);
    return this.modernShutdownPromise;
  }
}
