import { Buffer } from "node:buffer";

/** Maximum UTF-8 bytes retained for one release-test diagnostic value. */
export const PTY_HOST_DIAGNOSTIC_MAX_BYTES = 8_192;

/** Maximum UTF-8 bytes forwarded from one PTY host stderr chunk. */
export const PTY_HOST_STDERR_MAX_BYTES = 8_192;

/** Named lifecycle boundaries emitted by the supervised PTY host. */
export type PtyHostDiagnosticPhase =
  | "supervisor.spawn"
  | "supervisor.ready"
  | "supervisor.heartbeat.first"
  | "supervisor.create"
  | "supervisor.degraded"
  | "supervisor.probe"
  | "supervisor.unhealthy"
  | "supervisor.child.exit"
  | "supervisor.child.error"
  | "runtime.handshake.received"
  | "runtime.native-load.start"
  | "runtime.native-load.end"
  | "runtime.native-load.error"
  | "runtime.ready.published"
  | "runtime.heartbeat.first"
  | "runtime.native-spawn.start"
  | "runtime.native-spawn.end"
  | "runtime.native-spawn.error"
  | "runtime.containment.establish.start"
  | "runtime.containment.establish.end"
  | "runtime.running.published";

/** Safe, bounded facts that a PTY lifecycle diagnostic can expose. */
export interface PtyHostDiagnosticDetails {
  readonly generation?: string;
  readonly requestedGeneration?: string;
  readonly state?: string;
  readonly pid?: number;
  readonly sessionId?: string;
  readonly code?: number | string | null;
  readonly signal?: number | string | null;
  readonly error?: string;
  readonly established?: boolean;
}

/** One timestamped, bounded release-test PTY lifecycle observation. */
export interface PtyHostDiagnostic extends PtyHostDiagnosticDetails {
  readonly timestamp: string;
  readonly phase: PtyHostDiagnosticPhase;
}

/** Receives one release-test PTY lifecycle observation. */
export type PtyHostDiagnosticSink = (diagnostic: PtyHostDiagnostic) => void;

/** Bounds one UTF-8 string before it crosses the release-test logging boundary. */
export function boundPtyHostText(
  text: string,
  maxBytes = PTY_HOST_DIAGNOSTIC_MAX_BYTES,
): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= maxBytes
    ? text
    : bytes.subarray(0, maxBytes).toString("utf8");
}

/** Emits one release-test-only lifecycle observation with bounded text fields. */
export function emitPtyHostDiagnostic(
  enabled: boolean,
  sink: PtyHostDiagnosticSink | undefined,
  phase: PtyHostDiagnosticPhase,
  details: PtyHostDiagnosticDetails = {},
): void {
  if (!enabled || !sink) return;
  sink({
    timestamp: new Date().toISOString(),
    phase,
    ...details,
    ...(details.generation === undefined
      ? {}
      : { generation: boundPtyHostText(details.generation) }),
    ...(details.requestedGeneration === undefined
      ? {}
      : { requestedGeneration: boundPtyHostText(details.requestedGeneration) }),
    ...(details.state === undefined ? {} : { state: boundPtyHostText(details.state) }),
    ...(details.sessionId === undefined
      ? {}
      : { sessionId: boundPtyHostText(details.sessionId) }),
    ...(details.error === undefined ? {} : { error: boundPtyHostText(details.error) }),
  });
}

/** Writes one bounded release-test diagnostic to the server stderr stream. */
export function writePtyHostDiagnostic(diagnostic: PtyHostDiagnostic): void {
  const serialized = boundPtyHostText(JSON.stringify(diagnostic));
  process.stderr.write(`[terminal-release-test] ${serialized}\n`);
}

/** Forwards one bounded PTY host stderr chunk to the release-test parent. */
export function forwardPtyHostStderr(text: string): void {
  process.stderr.write(`[pty-host.stderr] ${boundPtyHostText(text, PTY_HOST_STDERR_MAX_BYTES)}`);
}
