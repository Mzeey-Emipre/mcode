import type { TerminalLaunchSnapshot } from "@mcode/contracts";
import type { PtyHostEvent } from "./pty-host-protocol.js";

/** Host health returned when a PTY host starts. */
export interface PtyHostHealth {
  readonly hostGeneration: string;
  readonly state: "starting" | "healthy" | "degraded" | "unhealthy" | "stopped";
}

/** Content-free measurements exposed by the supervised PTY host. */
export interface PtyHostDiagnostics {
  readonly lastHeartbeatMsAgo: number | null;
  readonly queueBytes: number;
  readonly eventLoopLagMs: number;
  readonly hostRssBytes: string;
}

/** Strict request that creates one native PTY. */
export interface PtyHostCreate {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly launch: TerminalLaunchSnapshot;
  readonly cwd: string;
  readonly protectedEnv: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly cols: number;
  readonly rows: number;
}

/** Confirmation that a native PTY is running under containment. */
export interface PtyHostRunning {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly state: "running";
  readonly containment: "job-object" | "process-group";
}

/** Ordered input or latest-wins resize command. */
export type PtyHostCommand =
  | {
      readonly sessionId: string;
      readonly hostGeneration: string;
      readonly attachmentEpoch: string;
      readonly commandSeq: string;
      readonly kind: "input";
      readonly data: Uint8Array;
    }
  | {
      readonly sessionId: string;
      readonly hostGeneration: string;
      readonly attachmentEpoch: string;
      readonly commandSeq: string;
      readonly kind: "resize";
      readonly data: { readonly cols: number; readonly rows: number };
    };

/** Ordered attachment-independent PTY close barrier. */
export interface PtyHostClose {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly closeSeq: string;
  readonly reason: "user" | "scope-reset" | "workspace-delete" | "app-shutdown";
}

/** Private process seam used by the Terminal session runtime. */
export interface PtyHostAdapter {
  start(): Promise<PtyHostHealth>;
  /** Returns the latest host measurements without session content. */
  diagnostics?(): PtyHostDiagnostics;
  create(input: PtyHostCreate): Promise<PtyHostRunning>;
  send(command: PtyHostCommand): Promise<void>;
  inspectChildren(
    sessionId: string,
    hostGeneration: string,
  ): Promise<{ hasChildren: boolean }>;
  close(input: PtyHostClose): Promise<void>;
  shutdown(): Promise<void>;
  subscribe(listener: (event: PtyHostEvent) => void): () => void;
}
