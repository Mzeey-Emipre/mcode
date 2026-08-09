import type {
  TerminalAttachmentDescriptor,
  TerminalLaunchSnapshot,
  TerminalScope,
  TerminalSessionSnapshot,
} from "@mcode/contracts";

/** Runtime request that reserves and creates one shell session. */
export interface CreateRuntimeSession {
  readonly sessionId: string;
  readonly scope: TerminalScope;
  readonly launch: TerminalLaunchSnapshot;
  readonly hostGeneration: string;
}

/** Runtime request that acquires one attachment lease. */
export interface AttachRuntimeSession {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly hostGeneration: string;
  readonly lastOutputSeq: string;
  readonly lastCommandSeq: string;
  readonly checkpointSeq: string | null;
}

/** Ordered input or resize command from the current attachment. */
export type TerminalAttachmentCommand =
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

/** Cumulative output acknowledgement from the current attachment. */
export interface TerminalOutputAcknowledgement {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly attachmentEpoch: string;
  readonly outputSeq: string;
}

/** Validated renderer checkpoint accepted by the runtime seam. */
export interface ValidatedTerminalCheckpoint {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly attachmentEpoch: string;
  readonly baseOutputSeq: string;
  readonly data: Uint8Array;
  readonly sha256: string;
}

/** Runtime request that releases one attachment lease. */
export interface DetachRuntimeSession {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly attachmentEpoch: string;
  readonly reason: "hide" | "switch" | "disconnect";
}

/** Runtime request that starts the attachment-independent close barrier. */
export interface CloseRuntimeSession {
  readonly sessionId: string;
  readonly reason: "user" | "scope-reset" | "workspace-delete" | "app-shutdown";
}

/** Deep modern-session seam that owns lifecycle, ordering, replay, and exit barriers. */
export interface TerminalSessionRuntime {
  createSession(input: CreateRuntimeSession): Promise<TerminalSessionSnapshot>;
  attach(input: AttachRuntimeSession): Promise<TerminalAttachmentDescriptor>;
  sendCommand(command: TerminalAttachmentCommand): Promise<void>;
  acknowledgeOutput(ack: TerminalOutputAcknowledgement): void;
  saveCheckpoint(checkpoint: ValidatedTerminalCheckpoint): Promise<void>;
  detach(input: DetachRuntimeSession): Promise<void>;
  close(input: CloseRuntimeSession): Promise<TerminalSessionSnapshot>;
  getSnapshot(sessionId: string): TerminalSessionSnapshot | null;
  shutdown(): Promise<void>;
}
