# Terminal v1 contract-freeze handoff

Status: implementation-ready contract pack for the [Produce the terminal v1
contract-freeze handoff pack](https://github.com/Mzeey-Empire/mcode/issues/1130).

This document freezes the public Terminal client/server contract and the
private server/PTY-host contract. It does not change production code, schemas,
settings documentation, migrations, or tests. The [What implementation sequence
delivers the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1106)
consumes this pack.

## Authority and decisions

The server owns Terminal policy, identity, scope, lifecycle, leases, ordering,
recovery classification, and shutdown. `TerminalSessionRuntime` owns session
mechanics. `PtyHostAdapter` is the private process seam; native PTY handles
never cross it and never become session identity. Product orchestration and
runtime mechanics remain separate modules. No module is a god service.

The following decisions are authoritative:

- [Wayfinder: make Mcode's Terminal stable and native-feeling](https://github.com/Mzeey-Empire/mcode/issues/1072) preserves the
  right-panel Terminal, shell sessions, one renderer, explicit replay gaps,
  and the human-facing scope model.
- [What resize and restoration behavior should Mcode standardize?](https://github.com/Mzeey-Empire/mcode/issues/1075) preserves complete
  cell fitting, tail or reading-anchor restoration, and independent tab state.
- [What measurable quality gates define a native-feeling Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1076) supplies the
  release performance, memory, process, accessibility, and packaging gates.
- [What cross-platform compatibility contract must every terminal engine satisfy?](https://github.com/Mzeey-Empire/mcode/issues/1077) defines the
  certified shell matrix and Terminal protocol behavior.
- [Which renderer should Mcode adopt?](https://github.com/Mzeey-Empire/mcode/issues/1078) selects strengthened
  xterm; Ghostty remains prototype evidence only.
- [Where should PTY ownership and process isolation live?](https://github.com/Mzeey-Empire/mcode/issues/1079) assigns native PTYs
  and process containment to one supervised Node host per server boot.
- [What session lifecycle, flow-control, and replay contract should Mcode use?](https://github.com/Mzeey-Empire/mcode/issues/1080) defines lifecycle,
  sequence, flow-control, replay, checkpoint, attachment, and exit barriers.
- [What human-facing capabilities and settings belong in the modernization?](https://github.com/Mzeey-Empire/mcode/issues/1081) defines profiles,
  interaction, search, links, accessibility, and recovery actions.
- [How should Mcode migrate, release, and roll back the selected terminal architecture?](https://github.com/Mzeey-Empire/mcode/issues/1082) defines Nightly
  rollout, startup-only legacy fallback, and removal before Stable.
- [What verification and observability contract will keep the Terminal stable?](https://github.com/Mzeey-Empire/mcode/issues/1083) defines health,
  diagnostics, failure injection, resource ceilings, and evidence retention.
- [Is the terminal modernization specification ready for implementation?](https://github.com/Mzeey-Empire/mcode/issues/1084) is the handoff audit.
  It supersedes older per-scope capacity wording: exited tabs and tombstones
  remain until explicit close or replacement, and capacity is one configurable
  app-wide limit with default 20.
- [What settings schema and persistence contract should the modernized Terminal use?](https://github.com/Mzeey-Empire/mcode/issues/1088) defines the
  versioned settings and profile persistence contract.
- [What exact modules and interfaces implement the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1104#issuecomment-5193678870)
  defines the module and interface map.
- [What exact packaging and CI changes ship the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1105)
  owns packaging and CI mechanics.
- [What implementation sequence delivers the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1106)
  owns the implementation sequence and migration checkpoints.

### Terminology

| Term                | Contract meaning                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell session       | One server-owned shell lifecycle. Public identity is `sessionId`.                                                                                                |
| Terminal attachment | One renderer controller lease over a session. Public identity is `attachmentId`; a lease is identified by `attachmentEpoch`.                                     |
| Terminal scope      | `{kind:"workspace",workspaceId}` or `{kind:"thread",workspaceId,threadId}`.                                                                                      |
| PTY host            | One private Node child process per server boot. It owns native PTY and containment handles.                                                                      |
| Tombstone           | Bounded retained output, checkpoint, final sequence, and exit metadata for an exited session. It occupies capacity until close or replacement reaches `running`. |
| Hydration           | Hidden renderer restore before input and visibility are enabled.                                                                                                 |
| Replay gap          | An explicit, bounded statement that retained bytes cannot reconstruct a requested sequence.                                                                      |

## Versioned primitives and limits

All public and private contracts use `contractVersion: 1` during the Nightly
compatibility window. JSON uses canonical UTF-8. Binary integers are unsigned,
big-endian. Node and browser implementations use `bigint`; JSON represents
sequence values as decimal strings.

| Primitive            | Exact representation and bound                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UUID                 | Lower-case RFC 4122 string, 36 bytes/chars, regex `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.                                                                                |
| `U64`                | Canonical decimal string with value `0..18_446_744_073_709_551_615`; exact grammar follows immediately below.                                                                                                 |
| Timestamp            | ISO-8601 UTC string, max 30 bytes, validated at the boundary.                                                                                                                                                 |
| Scope ID             | UUID. A thread must belong to the supplied workspace.                                                                                                                                                         |
| Terminal dimensions  | `cols: 1..1000`, `rows: 1..500`, integers.                                                                                                                                                                    |
| Command payload      | UTF-8 bytes, max 65,536 bytes per command. Input is not decoded as a shell command.                                                                                                                           |
| Unacknowledged input | Max 262,144 bytes per attachment. Full input blocks further input and shows `Input stalled`.                                                                                                                  |
| Output batch         | Max 65,536 bytes or 16 ms, whichever comes first. Flush before exit.                                                                                                                                          |
| Watermarks           | Server high/low `1,048,576/262,144` bytes; renderer high/low `262,144/65,536` bytes.                                                                                                                          |
| Replay               | Derived from renderer lines: `clamp(scrollback * 512, 65,536, 8,388,608)` bytes.                                                                                                                              |
| Renderer scrollback  | 100..5,000 lines, default 1,000. Legacy migration maps `0` to 5,000, `1..99` to 100, leaves `100..5,000` unchanged, and maps values above 5,000 to 5,000. |
| Checkpoint           | One validated checkpoint per session, max 8,388,608 bytes.                                                                                                                                                    |
| JSON RPC request     | Max 131,072 bytes including envelope. Error body max 8,192 bytes.                                                                                                                                             |
| Diagnostics batch    | Max 128 events or 64 KiB, whichever comes first. Ring is five minutes or 2,048 events per host.                                                                                                               |
| Profiles             | Max 32 custom profiles. Name 1..64 trimmed chars, no controls. Executable max 1,024 chars. Up to 32 arguments, each max 1,024 chars, aggregate max 8 KiB.                                                     |
| App session capacity | `terminal.behavior.sessionLimit`, integer 1..20, default 20. It counts `starting`, `running`, `exiting`, `exited`, and `failed` tombstones until close or replacement reaches `running`. It is not per scope. |
| Startup fallback     | Modern backend selection has a five-second monotonic deadline. While selecting, Terminal reports `Starting`; shell creation is rejected with `HOST_STARTING`.                                                 |

The exact `U64` grammar is `^(0|[1-9][0-9]{0,19})$`. Values are parsed as
unsigned 64-bit integers. Leading zeroes, signs, fractions, exponents, and
JavaScript number encodings are rejected.

Validation is strict: unknown keys, malformed discriminants, noncanonical
sequences, wrong lengths, and out-of-range values fail closed with
`PROTOCOL_MISMATCH` (or the operation-specific validation error below). No
success-shaped fallback is permitted.

## Public model schemas

The following schemas belong in `packages/contracts/src/models/terminal.ts` and
are strict, lazily constructed schemas. Fields not marked optional are always
present. The schema rejects unknown keys.

```ts
type TerminalScope =
  | { kind: "workspace"; workspaceId: UUID }
  | { kind: "thread"; workspaceId: UUID; threadId: UUID };

type TerminalSessionState =
  "starting" | "running" | "exiting" | "exited" | "failed";

type CertifiedProfileId =
  | "certified:windows-powershell-5.1"
  | "certified:windows-powershell-7"
  | "certified:windows-cmd"
  | "certified:windows-git-bash"
  | "certified:windows-wsl"
  | "certified:macos-zsh"
  | "certified:macos-bash"
  | "certified:linux-bash"
  | "certified:linux-zsh";

type TerminalResolvedProfile = {
  id: CertifiedProfileId | `custom:${UUID}`;
  name: string; // 1..64 chars
  executable: string; // 1..1024 chars
  arguments: string[]; // <=32 entries, <=8 KiB aggregate
  source: "certified" | "custom";
  platform: "windows" | "macos" | "linux";
};

type CustomProfile = {
  id: `custom:${UUID}`;
  name: string;
  executable: string;
  arguments: string[];
};

type TerminalLaunchSnapshot = {
  requestedProfileId: "automatic" | CertifiedProfileId | `custom:${UUID}`;
  resolvedProfile: TerminalResolvedProfile;
  scope: TerminalScope;
  arguments: string[]; // exact resolved argv, <=32 entries
};

type TerminalExitMetadata = {
  code: number | null; // integer -2,147,483,648..2,147,483,647, null when signal-only
  signal: number | null; // integer 0..65,535, null when no signal
  reason:
    | "natural"
    | "user-close"
    | "host-crash"
    | "containment-failure"
    | "protocol-failure";
};

type TerminalSessionSnapshot = {
  contractVersion: 1;
  sessionId: UUID;
  scope: TerminalScope;
  state: TerminalSessionState;
  hostGeneration: U64;
  launch: TerminalLaunchSnapshot;
  createdAt: Timestamp;
  lastCommandSeq: U64;
  lastOutputSeq: U64;
  exit: TerminalExitMetadata | null;
  tombstone: boolean;
};

type TerminalAttachmentDescriptor = {
  contractVersion: 1;
  sessionId: UUID;
  attachmentId: UUID;
  attachmentEpoch: U64;
  hostGeneration: U64;
  hydrationId: UUID;
  inputEnabled: false;
  serverHighBytes: 1048576;
  serverLowBytes: 262144;
  clientHighBytes: 262144;
  clientLowBytes: 65536;
};

type TerminalGap = {
  kind: "replay";
  firstMissingSeq: U64;
  lastMissingSeq: U64;
  retainedFromSeq: U64;
  retainedThroughSeq: U64;
  reason:
    "evicted" | "stale-checkpoint" | "generation-reset" | "checkpoint-rejected";
};

type TerminalHydrationDescriptor = {
  hydrationId: UUID;
  mode: "delta" | "checkpoint-delta" | "reset-tail-gap";
  requestedAfterSeq: U64;
  checkpointThroughSeq: U64 | null;
  firstOutputSeq: U64 | null;
  lastOutputSeq: U64 | null;
  gap: TerminalGap | null;
  chunkCount: number; // 0..128
  totalBytes: number; // 0..8 MiB
};

type TerminalError = {
  code:
    | "INVALID_SCOPE"
    | "PROFILE_NOT_FOUND"
    | "PROFILE_UNAVAILABLE"
    | "PROFILE_IN_USE"
    | "SLOT_LIMIT_REACHED"
    | "HOST_STARTING"
    | "HOST_UNHEALTHY"
    | "STALE_HOST_GENERATION"
    | "STALE_ATTACHMENT"
    | "COMMAND_OUT_OF_ORDER"
    | "INPUT_STALLED"
    | "INPUT_DELIVERY_UNKNOWN"
    | "REPLAY_GAP"
    | "CHECKPOINT_REJECTED"
    | "CONTAINMENT_FAILED"
    | "SESSION_NOT_FOUND"
    | "SESSION_NOT_RUNNING"
    | "EXIT_FLUSH_FAILED"
    | "PROTOCOL_MISMATCH"
    | "BACKEND_RESTART_REQUIRED"
    | "SETTINGS_INVALID"
    | "SETTINGS_WRITE_BLOCKED"
    | "WORKSPACE_NOT_FOUND";
  message: string; // 1..512 chars, no shell content
  retry:
    "SAFE_RETRY" | "UNKNOWN_DELIVERY" | "REATTACH" | "NEW_SESSION" | "RESTART";
  correlationId: string; // temporary, <=64 chars
};
```

The server runtime seam uses these concrete interfaces. The named input types
are strict records composed from the schemas above; they never contain a native
PTY handle or a renderer object.

```ts
type U32 = number; // integer 0..4,294,967,295
type NativeAbi = string; // ASCII 1..64 chars, ^[A-Za-z0-9._-]+$
type ProcessGroupId = string; // opaque 1..128 chars
type ExitCode = number; // signed i32, -2,147,483,648..2,147,483,647
type ExitSignal = number; // u16, 0..65,535
type HostCapability = "conpty" | "posix-pty" | "job-object" | "process-group";
type PtyFailureBoundary =
  "startup" | "create" | "command" | "output" | "containment" | "shutdown";
type PtyFailureCode =
  "HOST_UNHEALTHY" | "CONTAINMENT_FAILED" | "PROTOCOL_MISMATCH";

interface TerminalSessionRuntime {
  createSession(input: {
    sessionId: UUID;
    scope: TerminalScope;
    launch: TerminalLaunchSnapshot;
    hostGeneration: U64;
  }): Promise<TerminalSessionSnapshot>;
  attach(input: {
    sessionId: UUID;
    attachmentId: UUID;
    hostGeneration: U64;
    lastOutputSeq: U64;
    lastCommandSeq: U64;
    checkpointSeq: U64 | null;
  }): Promise<TerminalAttachmentDescriptor>;
  sendCommand(command: {
    sessionId: UUID;
    hostGeneration: U64;
    attachmentEpoch: U64;
    commandSeq: U64;
    kind: "input" | "resize";
    data: Uint8Array | { cols: number; rows: number };
  }): Promise<void>;
  acknowledgeOutput(ack: {
    sessionId: UUID;
    hostGeneration: U64;
    attachmentEpoch: U64;
    outputSeq: U64;
  }): void;
  saveCheckpoint(checkpoint: {
    sessionId: UUID;
    hostGeneration: U64;
    attachmentEpoch: U64;
    baseOutputSeq: U64;
    data: Uint8Array; // 1..8 MiB
    sha256: string; // lowercase 64-hex digest
  }): Promise<void>;
  detach(input: {
    sessionId: UUID;
    attachmentId: UUID;
    attachmentEpoch: U64;
    reason: "hide" | "switch" | "disconnect";
  }): Promise<void>;
  close(input: {
    sessionId: UUID;
    reason: "user" | "scope-reset" | "workspace-delete" | "app-shutdown";
  }): Promise<TerminalSessionSnapshot>;
  getSnapshot(sessionId: UUID): TerminalSessionSnapshot | null;
  shutdown(): Promise<void>;
}

interface PtyHostAdapter {
  start(): Promise<{ hostGeneration: U64; state: "starting" | "healthy" }>;
  create(input: {
    sessionId: UUID;
    hostGeneration: U64;
    launch: TerminalLaunchSnapshot;
    cwd: string;
    protectedEnv: Array<{ name: string; value: string }>; // <=256 entries; canonical JSON <=65,536 UTF-8 bytes
    cols: number;
    rows: number;
  }): Promise<{
    sessionId: UUID;
    hostGeneration: U64;
    state: "running";
    containment: "job-object" | "process-group";
  }>;
  send(command: {
    sessionId: UUID;
    hostGeneration: U64;
    attachmentEpoch: U64;
    commandSeq: U64;
    kind: "input" | "resize";
    data: Uint8Array | { cols: number; rows: number };
  }): Promise<void>;
  inspectChildren(
    sessionId: UUID,
    hostGeneration: U64,
  ): Promise<{ hasChildren: boolean }>;
  close(input: {
    sessionId: UUID;
    hostGeneration: U64;
    closeSeq: U64;
    reason: "user" | "scope-reset" | "workspace-delete" | "app-shutdown";
  }): Promise<void>;
  shutdown(): Promise<void>;
  subscribe(listener: (event: PtyHostEvent) => void): () => void;
}

type PtyHostEvent =
  | {
      kind: "ready";
      hostGeneration: U64;
      platform: "windows" | "macos" | "linux";
      nativeAbi: NativeAbi;
      capabilities: HostCapability[]; // unique, max 4
    }
  | {
      kind: "heartbeat";
      hostGeneration: U64;
      monotonicMs: U64;
      activeSessions: number; // integer 0..20
      queueBytes: number; // integer 0..1,048,576
      rssBytes: U64; // nonnegative bytes
    }
  | {
      kind: "running";
      sessionId: UUID;
      hostGeneration: U64;
      rootPid: U32;
      processGroupId: ProcessGroupId;
      containment: "job-object" | "process-group";
    }
  | {
      kind: "commandAck";
      sessionId: UUID;
      hostGeneration: U64;
      attachmentEpoch: U64;
      appliedCommandSeq: U64;
      appliedOutputSeq: U64;
    }
  | {
      kind: "output";
      sessionId: UUID;
      hostGeneration: U64;
      outputSeq: U64;
      dataBase64: string; // base64 1..87,384 chars
    }
  | {
      kind: "exit";
      sessionId: UUID;
      hostGeneration: U64;
      finalOutputSeq: U64;
      code: ExitCode | null;
      signal: ExitSignal | null;
      reason:
        | "natural"
        | "user-close"
        | "host-crash"
        | "containment-failure"
        | "protocol-failure";
    }
  | {
      kind: "containment";
      sessionId: UUID;
      hostGeneration: U64;
      established: boolean;
      mechanism: "job-object" | "process-group";
      processGroupId: ProcessGroupId;
    }
  | {
      kind: "failure";
      hostGeneration: U64;
      boundary: PtyFailureBoundary;
      recoverable: boolean;
      code: PtyFailureCode;
    };
```

`TerminalSessionService` is the product adapter around this runtime. It owns
scope validation, profile resolution, app-wide capacity, immutable launch
snapshots, backend selection, settings application, recovery labels, and
`closeScope(scope)`. `TerminalBackendSelector` chooses `ModernTerminalBackend`
or `LegacyTerminalBackend` before any shell starts and never changes the value
for that boot. `PtyHostSupervisor` is the production `PtyHostAdapter`; tests
inject an in-memory adapter.

`TerminalBackendCapabilities` has exactly these fields: `contractVersion: 1`,
`backend: "modern" | "legacy"`, `selectedAt: Timestamp`,
`publicFrameVersion: 1`, `recovery: { replay: true; checkpoint: true; gap: true }`,
`host: { state: "starting" | "healthy" | "degraded" | "unhealthy" | "stopped"; generation: U64 }`,
and `sessionLimit: number` in 1..20. The backend value is fixed for the boot.

### Closed error vocabulary

The public error union is closed. `INTERNAL_CONTRACT_FAILURE` is transport
only and is never converted to a user-facing success.

| Code                       | Meaning                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `INVALID_SCOPE`            | Scope discriminant, IDs, ownership, or working-directory resolution is invalid.                          |
| `PROFILE_NOT_FOUND`        | Requested profile ID has no current definition.                                                          |
| `PROFILE_UNAVAILABLE`      | Profile executable or certified shell is not installed or cannot start.                                  |
| `PROFILE_IN_USE`           | A profile is referenced as global or workspace default and cannot be deleted.                            |
| `SLOT_LIMIT_REACHED`       | App-wide session limit is reached; exited and failed tombstones count.                                   |
| `HOST_STARTING`            | Backend or host selection is still within the five-second startup window.                                |
| `HOST_UNHEALTHY`           | Host heartbeat/probe or bounded resource policy is unhealthy.                                            |
| `STALE_HOST_GENERATION`    | Message targets a prior host generation.                                                                 |
| `STALE_ATTACHMENT`         | Attachment ID or epoch is not the current lease.                                                         |
| `COMMAND_OUT_OF_ORDER`     | Command sequence is not the next accepted sequence.                                                      |
| `INPUT_STALLED`            | Unacknowledged input reached 256 KiB or acknowledgement timed out.                                       |
| `INPUT_DELIVERY_UNKNOWN`   | Connection ended after input could have reached the host; delivery cannot be inferred.                   |
| `REPLAY_GAP`               | Retention cannot reconstruct requested output.                                                           |
| `CHECKPOINT_REJECTED`      | Checkpoint is stale, oversized, malformed, incomplete, duplicated with different bytes, or out of order. A missing chunk detected by `checkpoint.complete` aborts the upload; the client reattaches and starts a new upload. |
| `CONTAINMENT_FAILED`       | Authoritative process containment could not be established.                                              |
| `SESSION_NOT_FOUND`        | Session ID is not present in memory or tombstones.                                                       |
| `SESSION_NOT_RUNNING`      | Operation requires a live `running` session.                                                             |
| `EXIT_FLUSH_FAILED`        | Exit barrier could not flush all preceding output or acknowledgements.                                   |
| `PROTOCOL_MISMATCH`        | Version, discriminant, field, size, encoding, or strict-schema failure.                                  |
| `BACKEND_RESTART_REQUIRED` | Boot-scoped backend cannot recover in place; restart is required.                                        |
| `SETTINGS_INVALID`         | Settings document or update violates its strict schema.                                                  |
| `SETTINGS_WRITE_BLOCKED`   | Malformed or future settings file is preserved and writes are blocked.                                   |
| `WORKSPACE_NOT_FOUND`      | Workspace preference target does not exist.                                                              |

Unknown internal failures map to `INTERNAL_CONTRACT_FAILURE` with a correlation
ID that contains no command, output, environment, path, PID, username, or
durable session identifier.

## Settings and diagnostics schemas

The target persisted document is version `0.0.1`. It follows the nested
settings rules in `docs/guides/settings-schema.md`; implementation updates to
that canonical reference are part of the separate [Reconcile the terminal
handoff with Mcode's canonical contracts](https://github.com/Mzeey-Empire/mcode/issues/1131)
ticket.

```json
{
  "meta": { "schemaVersion": "0.0.1" },
  "terminal": {
    "defaultProfileId": "automatic",
    "profiles": [],
    "presentation": {
      "fontFamily": "mcodeMono",
      "fontSize": "sm",
      "lineHeight": "normal",
      "cursorStyle": "block",
      "cursorBlink": false,
      "ligatures": false
    },
    "behavior": {
      "scrollback": 1000,
      "sessionLimit": 20,
      "confirmOnKill": "withChildProcesses",
      "copyOnSelect": false,
      "confirmMultilinePaste": true
    },
    "accessibility": { "screenReaderMode": "off" },
    "flowControl": {
      "serverHighBytes": 1048576,
      "serverLowBytes": 262144,
      "clientHighBytes": 262144,
      "clientLowBytes": 65536
    }
  }
}
```

`fontSize` is one of `xs|sm|md|lg|xl` mapped to `1.0|1.2|1.4|1.6|2.0rem`.
`lineHeight` is `compact|normal|relaxed` mapped to `1.2|1.333|1.5`.
`cursorStyle` is `block|underline|bar`. `screenReaderMode` is `off|auto|on`.
`confirmOnKill` is `never|withChildProcesses|always`. `scrollback` is 100..5000.
Legacy scrollback migration maps `0` to 5000, `1..99` to 100, leaves
`100..5000` unchanged, and maps values above 5000 to 5000.
`sessionLimit` is 1..20 and is app-wide. Flow-control values are fixed
operational values and remain out of the normal settings UI.

Custom profile records contain only server-generated `id`, `name`,
`executable`, and `arguments`. They never contain environment values or a
working directory. Workspace preferences contain only
`workspaceId`, `defaultProfileId`, and `updatedAt`; no row means inherit.

Diagnostics schemas are content-free and strict:

```ts
type MetricId =
  | "session.create.ms"
  | "input.keydownToWrite.ms"
  | "output.receiptToEmulator.ms"
  | "output.receiptToPaint.ms"
  | "attachment.hydration.ms"
  | "attachment.replay.ms"
  | "session.switch.ms"
  | "session.resize.ms"
  | "session.exitFlush.ms"
  | "process.cleanup.ms"
  | "queue.pressure.bytes"
  | "input.unacknowledged.bytes"
  | "replay.retained.bytes"
  | "host.rss.bytes"
  | "host.eventLoopLag.ms"
  | "replay.gap.count"
  | "attachment.ackStall.count"
  | "attachment.revoked.count"
  | "checkpoint.rejected.count"
  | "protocol.violation.count"
  | "cleanup.forced.count"
  | "host.restart.count"
  | "exitBarrier.failed.count";

type TerminalHealthSnapshot = {
  contractVersion: 1;
  state: "starting" | "healthy" | "degraded" | "unhealthy" | "stopped";
  hostGeneration: U64;
  activeSessions: number; // 0..20
  lastHeartbeatMsAgo: number | null; // 0..60000, monotonic-derived
  queueBytes: number; // 0..1048576
  eventLoopLagMs: number; // 0..10000
  hostRssBytes: U64;
};

type TerminalDiagnosticEvent = {
  eventId: UUID;
  at: Timestamp;
  metric: MetricId;
  unit: "ms" | "bytes" | "count";
  value: number; // finite, 0..9007199254740991; metric table below narrows it
  outcome: "ok" | "degraded" | "failed";
  correlationId: string; // temporary, 1..64 chars
};

type DiagnosticCounter = {
  metric: MetricId;
  value: number; // integer 0..9007199254740991
};

type DiagnosticHistogram = {
  metric: MetricId;
  unit: "ms" | "bytes" | "count";
  count: number; // integer 0..100000
  p50: number; // 0..9007199254740991
  p95: number; // 0..9007199254740991
  p99: number; // 0..9007199254740991
};

type TerminalDiagnosticsBundle = {
  contractVersion: 1;
  generatedAt: Timestamp;
  backend: "modern" | "legacy";
  health: TerminalHealthSnapshot;
  events: TerminalDiagnosticEvent[]; // <=128 per report, <=2048 retained
  counters: DiagnosticCounter[]; // <=64 unique metric IDs
  histograms: DiagnosticHistogram[]; // <=64 unique metric IDs
};
```

The redactor rejects shell input, output, commands, environment values, working
directories, profile arguments, usernames, raw PIDs, and durable session IDs.
Metric IDs ending in `.ms` use `unit:"ms"` and are bounded to 600,000; IDs
ending in `.bytes` use `unit:"bytes"` and are bounded to 8,388,608 except
`host.rss.bytes`, which is bounded to `9007199254740991`; IDs ending in
`.count` use `unit:"count"` and are bounded to 2,048 except
`host.restart.count`, which is bounded to 20. Counter and histogram metric IDs
must be unique within their arrays, and all histogram percentiles satisfy
`p50 <= p95 <= p99`.

## Public management RPC

Every method is a strict JSON RPC method under `packages/contracts/src/ws/terminal.ts`.
The request envelope is `{id: UUID, method, params}` and the response is
`{id, result}` or `{id, error: TerminalError}`. A request ID is not a delivery
acknowledgement. A disconnect or timeout before the response means the result
is unknown and the operation-specific rule below applies.

### Methods and exact payloads

| Method                                 | Params                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Result                                                                                | Closed errors and retry class                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal.capabilities`                | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `TerminalBackendCapabilities`                                                         | `HOST_STARTING=SAFE_RETRY`, `HOST_UNHEALTHY=SAFE_RETRY`, `BACKEND_RESTART_REQUIRED=RESTART`, `PROTOCOL_MISMATCH=RESTART`.                                                                                                                                                                                                                                                           |
| `terminal.session.create`              | `{scope, requestedProfileId?, replacesSessionId?}`; one-time profile is `automatic`, certified ID, custom ID, or omitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `TerminalSessionSnapshot` with `state:"running"`                                      | `INVALID_SCOPE=NEW_SESSION`, `PROFILE_NOT_FOUND=NEW_SESSION`, `PROFILE_UNAVAILABLE=NEW_SESSION`, `SLOT_LIMIT_REACHED=NEW_SESSION`, `HOST_STARTING=SAFE_RETRY`, `HOST_UNHEALTHY=NEW_SESSION`, `CONTAINMENT_FAILED=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; call `session.list`, then attach the discovered session or create once if absent. |
| `terminal.session.list`                | `{scope?}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `TerminalSessionSnapshot[]` ordered by `createdAt`, max 20                            | `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`; list is read-only.                                                                                                                                                                                                                                                                                                     |
| `terminal.session.attach`              | `{sessionId, attachmentId, hostGeneration, lastOutputSeq, lastCommandSeq, checkpointSeq?}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `TerminalAttachmentDescriptor` followed by hydration frames                           | `SESSION_NOT_FOUND=NEW_SESSION`, `SESSION_NOT_RUNNING=NEW_SESSION`, `STALE_HOST_GENERATION=REATTACH`, `STALE_ATTACHMENT=REATTACH`, `REPLAY_GAP=REATTACH`, `HOST_UNHEALTHY=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `REATTACH`; never enable input until hydration complete.                                                                                        |
| `terminal.session.detach`              | `{sessionId, attachmentId, attachmentEpoch, reason:"hide"                                                                &#124; "switch"                                                                        &#124; "disconnect"}`                                                                                                                                                                                                                                                                                                                                                                                              | `{detached:true}`                                                                     | `SESSION_NOT_FOUND=SAFE_RETRY`, `STALE_ATTACHMENT=SAFE_RETRY`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`; detach is idempotent.                                                                                                                                                                                                                                   |
| `terminal.session.close`               | `{sessionId, reason:"user"                                                                                               &#124; "scope-reset"                                                                   &#124; "workspace-delete"                                                                                                                                                                                                                                                                                                                                                                  &#124; "app-shutdown"}` | `TerminalSessionSnapshot` with `state:"exited"` or `"failed"`                         | `SESSION_NOT_FOUND=SAFE_RETRY`, `SESSION_NOT_RUNNING=SAFE_RETRY`, `STALE_HOST_GENERATION=SAFE_RETRY`, `HOST_UNHEALTHY=SAFE_RETRY`, `CONTAINMENT_FAILED=NEW_SESSION`, `EXIT_FLUSH_FAILED=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`; close is a server-owned idempotent barrier and never replays input.                                                 |
| `terminal.session.hasChildren`         | `{sessionId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `{hasChildren:boolean}`                                                               | `SESSION_NOT_FOUND=SAFE_RETRY`, `HOST_UNHEALTHY=SAFE_RETRY`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`.                                                                                                                                                                                                                                                           |
| `terminal.session.checkpoint.begin`    | `{sessionId, attachmentId, attachmentEpoch, hostGeneration, baseOutputSeq, declaredBytes, sha256}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `{uploadId, chunkBytes:65536, expiresAfterMs:10000}`                                  | `SESSION_NOT_FOUND=REATTACH`, `STALE_ATTACHMENT=REATTACH`, `STALE_HOST_GENERATION=REATTACH`, `CHECKPOINT_REJECTED=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `REATTACH`; do not assume an upload identity.                                                                                                                                                           |
| `terminal.session.checkpoint.complete` | `{sessionId, attachmentId, attachmentEpoch, hostGeneration, uploadId, totalBytes, sha256}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `{accepted:true, checkpointThroughSeq}`                                               | `SESSION_NOT_FOUND=REATTACH`, `STALE_ATTACHMENT=REATTACH`, `STALE_HOST_GENERATION=REATTACH`, `CHECKPOINT_REJECTED=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. This JSON method is the sole upload authority: it validates that every chunk is present and the hash/size match. A missing chunk aborts the upload; the client reattaches and starts a new upload. Unknown result is `UNKNOWN_DELIVERY`; reattach before starting a new upload. |
| `terminal.profile.list`                | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `{certified:TerminalResolvedProfile[], custom:CustomProfile[]}`; max 64 records       | `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`.                                                                                                                                                                                                                                                                                                                        |
| `terminal.profile.create`              | `{name, executable, arguments}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `CustomProfile` with server-generated ID                                              | `PROFILE_UNAVAILABLE=NEW_SESSION`, `SETTINGS_INVALID=NEW_SESSION`, `SETTINGS_WRITE_BLOCKED=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; list and match by exact name/executable/arguments before retry.                                                                                                                                             |
| `terminal.profile.update`              | `{profileId, name, executable, arguments}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `CustomProfile`                                                                       | `PROFILE_NOT_FOUND=NEW_SESSION`, `PROFILE_UNAVAILABLE=NEW_SESSION`, `SETTINGS_INVALID=NEW_SESSION`, `SETTINGS_WRITE_BLOCKED=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; list and compare profile ID.                                                                                                                                               |
| `terminal.profile.delete`              | `{profileId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `{deleted:true}`                                                                      | `PROFILE_NOT_FOUND=SAFE_RETRY`, `PROFILE_IN_USE=NEW_SESSION`, `SETTINGS_WRITE_BLOCKED=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; list before retry.                                                                                                                                                                                               |
| `terminal.profile.setDefault`          | `{profileId}` where the value is `automatic`, `certified:<id>`, or `custom:<uuid>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `{defaultProfileId}`                                                                  | `PROFILE_NOT_FOUND=NEW_SESSION`, `SETTINGS_INVALID=NEW_SESSION`, `SETTINGS_WRITE_BLOCKED=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; read settings and compare.                                                                                                                                                                                    |
| `terminal.workspacePreferences.get`    | `{workspaceId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `{workspaceId, defaultProfileId}` where value is `automatic`, a profile ID, or `null` | `WORKSPACE_NOT_FOUND=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`.                                                                                                                                                                                                                                                                                     |
| `terminal.workspacePreferences.update` | `{workspaceId, defaultProfileId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `{workspaceId, defaultProfileId}`                                                     | `WORKSPACE_NOT_FOUND=NEW_SESSION`, `PROFILE_NOT_FOUND=NEW_SESSION`, `SETTINGS_INVALID=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; get and compare.                                                                                                                                                                                             |
| `terminal.workspacePreferences.reset`  | `{workspaceId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `{reset:true}`                                                                        | `WORKSPACE_NOT_FOUND=SAFE_RETRY`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`; reset is idempotent.                                                                                                                                                                                                                                                                 |
| `terminal.preferences.reset`           | `{workspaceId?}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `{reset:true}`                                                                        | `SETTINGS_WRITE_BLOCKED=RESTART`, `SETTINGS_INVALID=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; read settings and workspace preference before retry.                                                                                                                                                                                           |
| `terminal.preferences.update`          | `{presentation?, behavior?, accessibility?}`; only the exact v1 fields above, max 128 KiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `{terminal:{presentation,behavior,accessibility}}`                                    | `SETTINGS_INVALID=NEW_SESSION`, `SETTINGS_WRITE_BLOCKED=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Unknown result is `UNKNOWN_DELIVERY`; read settings and compare.                                                                                                                                                                                                                     |
| `terminal.diagnostics.report`          | `{events:TerminalDiagnosticEvent[]}`; max 128 events/64 KiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `{accepted:number}`                                                                   | `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`; events are content-free and deduplicated by event ID.                                                                                                                                                                                                                                                                  |
| `terminal.diagnostics.getBundle`       | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `TerminalDiagnosticsBundle`, max 512 KiB                                              | `PROTOCOL_MISMATCH=RESTART`. Unknown result is `SAFE_RETRY`; bundle generation has no product side effect.                                                                                                                                                                                                                                                                          |

`SAFE_RETRY` means retrying the same request cannot create another session,
change a profile twice, or deliver input twice. `REATTACH` means acquire a new
attachment and hydrate before any command. `NEW_SESSION` means the requested
session cannot satisfy the operation. `RESTART` means restart the current
binary; the selected backend never changes inside a boot. `UNKNOWN_DELIVERY`
means no automatic retry; reconcile through the read operation specified in the
table.

## Binary attachment codec

`packages/contracts/src/ws/terminal-binary.ts` defines one self-describing v1
envelope. The decoder rejects unknown family, version, kind, flags, IDs,
sequence encodings, payload lengths, and trailing bytes.

### Envelope layout

All integer fields are big-endian. The fixed header is 52 bytes.

|    Offset |       Size | Field             | Constraint                                                        |
| --------: | ---------: | ----------------- | ----------------------------------------------------------------- |
|         0 |          2 | Magic             | `0x4d 0x54` (`MT`)                                                |
|         2 |          1 | `contractVersion` | `1`                                                               |
|         3 |          1 | `frameKind`       | Kind table below                                                  |
|         4 |          2 | `flags`           | `0`; any bit is `PROTOCOL_MISMATCH`                               |
|         6 |          2 | `sessionIdLen`    | Exactly 36                                                        |
|         8 |          2 | `attachmentIdLen` | Exactly 36                                                        |
|        10 |          2 | `hydrationIdLen`  | 0 or 36                                                           |
|        12 |          2 | `uploadIdLen`     | 0 or 36                                                           |
|        14 |          8 | `hostGeneration`  | u64                                                               |
|        22 |          8 | `attachmentEpoch` | u64                                                               |
|        30 |          8 | `primarySeq`      | u64                                                               |
|        38 |          8 | `relatedSeq`      | u64                                                               |
|        46 |          4 | `payloadLen`      | 0..65,536                                                         |
|        50 |          2 | `reserved`        | `0`                                                               |
|        52 |   variable | IDs               | UTF-8 UUID bytes in order: session, attachment, hydration, upload |
| after IDs | payloadLen | Payload           | Kind-specific bytes                                               |

The envelope including IDs and payload is at most 70,000 bytes. Payloads are
binary UTF-8 bytes where stated, never base64. A frame with a missing required
ID, nonzero unused ID length, or a sequence outside the operation's ordering
rule is rejected before dispatch.

### Frame kinds and payloads

| Direction/kind                      | IDs and sequence fields                                                                | Payload                                                                                      | Errors and retry class                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client `0x01 input`                 | session, attachment; `primarySeq=commandSeq`, related `0`                              | UTF-8 input, 1..65,536 bytes                                                                 | `STALE_HOST_GENERATION=REATTACH`, `STALE_ATTACHMENT=REATTACH`, `COMMAND_OUT_OF_ORDER=REATTACH`, `INPUT_STALLED=REATTACH`, `SESSION_NOT_RUNNING=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Delivery unknown is `INPUT_DELIVERY_UNKNOWN`; never resend automatically. |
| Client `0x02 resize`                | session, attachment; `primarySeq=commandSeq`, related `0`                              | 4 bytes: cols u16, rows u16                                                                  | Same identity errors as input; `COMMAND_OUT_OF_ORDER=REATTACH`, `SESSION_NOT_RUNNING=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Delivery unknown is safe latest-wins retry after reattach.                                                                          |
| Client `0x03 outputAck`             | session, attachment; `primarySeq=highestContiguousOutputSeq`                           | Empty                                                                                        | `STALE_ATTACHMENT=REATTACH`, `STALE_HOST_GENERATION=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Delivery unknown is safe; reconnect reports the server floor.                                                                                                           |
| Client `0x04 checkpointChunk`       | session, attachment, upload; `primarySeq=chunkIndex`, `relatedSeq=chunkCount (1..128)` | 1..65,536 bytes                                                                              | `STALE_ATTACHMENT=REATTACH`, `STALE_HOST_GENERATION=REATTACH`, `CHECKPOINT_REJECTED=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Chunks have no acknowledgement; JSON `checkpoint.complete` validates completeness and either installs or aborts the upload.                                |
| Server `0x81 commandAck`            | session, attachment; `primarySeq=highestAppliedCommandSeq`, related `highestOutputSeq` | Empty                                                                                        | `STALE_ATTACHMENT=REATTACH`, `STALE_HOST_GENERATION=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Missing ack triggers `INPUT_DELIVERY_UNKNOWN` after two seconds.                                                                                                        |
| Server `0x82 output`                | session, attachment, optional hydration; `primarySeq=outputSeq`, related `0`           | UTF-8 PTY bytes, 1..65,536                                                                   | `STALE_ATTACHMENT=REATTACH`, `STALE_HOST_GENERATION=REATTACH`, `REPLAY_GAP=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Output is never silently discarded while live.                                                                                                   |
| Server `0x83 hydrationChunk`        | session, attachment, hydration; `primarySeq=chunkIndex`, related `chunkCount`          | checkpoint or replay bytes, 1..65,536                                                        | `REPLAY_GAP=REATTACH`, `CHECKPOINT_REJECTED=REATTACH`, `STALE_HOST_GENERATION=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Renderer remains hidden and input-disabled until complete.                                                                                    |
| Server `0x84 hydrationComplete`     | session, attachment, hydration; `primarySeq=lastOutputSeq`, related `0`                | Strict JSON `TerminalHydrationDescriptor`, max 4 KiB                                         | `REPLAY_GAP=REATTACH`, `STALE_ATTACHMENT=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Missing completion keeps renderer hidden.                                                                                                                                          |
| Server `0x85 state`                 | session, attachment; `primarySeq=lastOutputSeq`, related `0`                           | Strict JSON `{state:TerminalSessionState, exit:TerminalExitMetadata &#124; null}`, max 2 KiB | `STALE_ATTACHMENT=REATTACH`, `PROTOCOL_MISMATCH=RESTART`.                                                                                                                                                                                                           |
| Server `0x86 gap`                   | session, attachment, hydration; sequences identify first/last missing output           | Strict JSON `TerminalGap`, max 2 KiB                                                         | `REPLAY_GAP=REATTACH`; no retry can manufacture evicted bytes.                                                                                                                                                                                                      |
| Server `0x87 exitBarrier`           | session, attachment; `primarySeq=finalOutputSeq`, related `highestAckedOutputSeq`      | Strict JSON `{finalOutputSeq, exit}`, max 2 KiB                                              | `EXIT_FLUSH_FAILED=REATTACH`, `STALE_ATTACHMENT=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Renderer publishes `Exited` only after writing through `finalOutputSeq` or showing the explicit gap.                                                                        |

`primarySeq` identifies the sequence the receiver must process next or confirm,
except for `checkpointChunk`, where it identifies the assembly index;
`relatedSeq` is only used where the row defines it. The receiver rejects a
duplicate with different bytes. Output acknowledgements are idempotent;
checkpoint chunks have no acknowledgement or selective retransmission, and
checkpoint completion is authoritative for the upload result.

## Private server/PTY-host protocol

`apps/server/src/terminal/host/pty-host-protocol.ts` owns the private protocol;
it is not exported from `packages/contracts`. Messages are strict JSON objects
with `contractVersion:1`, a message-specific `hostGeneration` field, `kind`, and a
bounded payload. Every session-scoped message carries `hostGeneration:U64`, and
the server validates it before dispatch. `handshake` carries
`requestedGeneration:U64`; `probe` and `shutdown` carry the current
`hostGeneration`. The inherited channel caps a message at 131,072 bytes. Output and
input payloads are base64 only inside this private protocol: at most 65,536
decoded bytes, represented by at most 87,384 base64 characters. Unknown kinds,
fields, generations, or sizes close the channel and produce
`PROTOCOL_MISMATCH`.

Private field bounds are fixed: `cwd` is an absolute path of 1..4,096 chars;
`executable` is 1..1,024 chars; `arguments` has at most 32 entries and 8 KiB
aggregate; `env` has at most 256 `{name,value}` pairs, names match
`^[A-Za-z_][A-Za-z0-9_]{0,127}$`, values are 0..8,192 chars, and the canonical
compact JSON encoding of the `env` field is at most 65,536 UTF-8 bytes,
including quotes, separators, and escaping. `env` is the protected EnvService
result and is never sent to diagnostics. A `create` is valid only when the
complete canonical JSON message is at most 131,072 bytes; the server computes
both bounds before writing and sends nothing when either bound fails. `rootPid`
is a u32 (`0..4,294,967,295`),
`processGroupId` is an opaque 1..128-char token, and `nativeAbi` is an ASCII
token matching `^[A-Za-z0-9._-]{1,64}$`.

The host capability object is exactly
`{pty:"conpty"|"posix-pty", containment:"job-object"|"process-group", maxSessions:20, protocolVersion:1}`.

### Server to host

The table lists payload fields in addition to the common `contractVersion:1`
and `kind`; every session-scoped row also includes `hostGeneration:U64`, even
when the column elides those common fields.

| Kind              | Required fields                                                                                                                                                                                                                                                                                                                                                                                                                 | Closed errors and retry class                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handshake`       | `{contractVersion:1, requestedGeneration:U64, platform:"windows"                                                                                          &#124; "macos"                                                                                                                                                                                                                                       &#124; "linux"}` | `PROTOCOL_MISMATCH=RESTART`, `HOST_UNHEALTHY=RESTART`. Unknown delivery is `BACKEND_RESTART_REQUIRED`.                                                                                                                                        |
| `create`          | `{sessionId, scope, executable, arguments, cwd, cols, rows, env}`; executable/args/cwd/env are resolved and bounded at this seam                                                                                                                                                                                                                                                                                                | `STALE_HOST_GENERATION=RESTART`, `CONTAINMENT_FAILED=NEW_SESSION`, `PROFILE_UNAVAILABLE=NEW_SESSION`, `HOST_UNHEALTHY=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Unknown delivery is `UNKNOWN_DELIVERY`; server lists host sessions before retry. |
| `command.input`   | `{sessionId, attachmentEpoch, commandSeq, dataBase64}`                                                                                                                                                                                                                                                                                                                                                                          | `STALE_ATTACHMENT=REATTACH`, `COMMAND_OUT_OF_ORDER=REATTACH`, `INPUT_STALLED=REATTACH`, `SESSION_NOT_RUNNING=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Unknown delivery is `INPUT_DELIVERY_UNKNOWN`; no retry.                               |
| `command.resize`  | `{sessionId, attachmentEpoch, commandSeq, cols, rows}`                                                                                                                                                                                                                                                                                                                                                                          | `STALE_ATTACHMENT=REATTACH`, `COMMAND_OUT_OF_ORDER=REATTACH`, `SESSION_NOT_RUNNING=NEW_SESSION`, `PROTOCOL_MISMATCH=RESTART`. Unknown delivery is latest-wins safe after reattach.                                                            |
| `inspectChildren` | `{sessionId, hostGeneration}`                                                                                                                                                                                                                                                                                                                                                                                                    | `SESSION_NOT_FOUND=SAFE_RETRY`, `STALE_HOST_GENERATION=SAFE_RETRY`, `HOST_UNHEALTHY=SAFE_RETRY`, `PROTOCOL_MISMATCH=RESTART`. Unknown delivery is `SAFE_RETRY`; the server validates `hostGeneration` before dispatch. |
| `close`           | `{sessionId, closeSeq:U64, reason:"user" &#124; "scope-reset" &#124; "workspace-delete" &#124; "app-shutdown"}`                                                                                                                                                                                                                                                                                                                 | `SESSION_NOT_FOUND=SAFE_RETRY`, `CONTAINMENT_FAILED=NEW_SESSION`, `EXIT_FLUSH_FAILED=REATTACH`, `HOST_UNHEALTHY=SAFE_RETRY`, `PROTOCOL_MISMATCH=RESTART`. Unknown delivery is `SAFE_RETRY`; close barrier is idempotent.                      |
| `probe`           | `{hostGeneration, nonce:UUID}`                                                                                                                                                                                                                                                                                                                                                                                                  | `HOST_UNHEALTHY=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Unknown delivery means mark host unhealthy after the one-second deadline.                                                                                                              |
| `shutdown`        | `{hostGeneration, reason:"app-shutdown"}`                                                                                                                                                                                                                                                                                                                                                                                       | `EXIT_FLUSH_FAILED=REATTACH`, `HOST_UNHEALTHY=SAFE_RETRY`, `PROTOCOL_MISMATCH=RESTART`. Unknown delivery means continue bounded forced cleanup.                                                                                               |

### Host to server

| Kind          | Required fields                                                                                                                                                                                                                       | Closed errors and retry class                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`       | `{hostGeneration, platform, nativeAbi, capabilities}`; platform is one of `windows`, `macos`, `linux`; capability object is the exact shape above                                                                                     | `PROTOCOL_MISMATCH=RESTART`; duplicate ready with another generation is `STALE_HOST_GENERATION=RESTART`.                                                                |
| `heartbeat`   | `{hostGeneration, monotonicMs:U64, activeSessions:0..20, queueBytes:0..1048576, rssBytes:U64}`                                                                                                                                        | `PROTOCOL_MISMATCH=RESTART`; missing heartbeat is handled by the health state machine.                                                                                  |
| `running`     | `{sessionId, hostGeneration, rootPid:U32, processGroupId, containment:"job-object" &#124; "process-group"}`                                                                                                                           | `CONTAINMENT_FAILED=NEW_SESSION`, `STALE_HOST_GENERATION=RESTART`, `PROTOCOL_MISMATCH=RESTART`.                                                                         |
| `commandAck`  | `{sessionId, hostGeneration, attachmentEpoch, appliedCommandSeq, appliedOutputSeq}`                                                                                                                                                   | `STALE_ATTACHMENT=REATTACH`, `STALE_HOST_GENERATION=RESTART`, `PROTOCOL_MISMATCH=RESTART`. Missing ack is `INPUT_DELIVERY_UNKNOWN`.                                     |
| `output`      | `{sessionId, hostGeneration, outputSeq, dataBase64}`; max 64 KiB                                                                                                                                                                      | `STALE_HOST_GENERATION=RESTART`, `SESSION_NOT_FOUND=SAFE_RETRY`, `PROTOCOL_MISMATCH=RESTART`. A duplicate sequence with different bytes is `PROTOCOL_MISMATCH=RESTART`. |
| `exit`        | `{sessionId, hostGeneration, finalOutputSeq:U64, code:-2147483648..2147483647&#124;null, signal:0..65535&#124;null, reason:"natural" &#124; "user-close" &#124; "host-crash" &#124; "containment-failure" &#124; "protocol-failure"}` | `STALE_HOST_GENERATION=RESTART`, `EXIT_FLUSH_FAILED=REATTACH`, `PROTOCOL_MISMATCH=RESTART`. Missing exit is a failed exit barrier, never success.                       |
| `containment` | `{sessionId, hostGeneration, established:boolean, mechanism:"job-object" &#124; "process-group", processGroupId:1..128 chars}`                                                                                                        | `CONTAINMENT_FAILED=NEW_SESSION`, `STALE_HOST_GENERATION=RESTART`, `PROTOCOL_MISMATCH=RESTART`.                                                                         |
| `failure`     | `{hostGeneration, boundary:"startup" &#124; "create" &#124; "command" &#124; "output" &#124; "containment" &#124; "shutdown", recoverable:boolean, code:"HOST_UNHEALTHY" &#124; "CONTAINMENT_FAILED" &#124; "PROTOCOL_MISMATCH"}`     | `HOST_UNHEALTHY=RESTART`, `BACKEND_RESTART_REQUIRED=RESTART`, `PROTOCOL_MISMATCH=RESTART`.                                                                              |

The host never sends cwd, environment values, profile arguments, usernames, or
raw PIDs to the renderer. Root PID and process-group identity are accepted only
by the server cleanup ledger and are redacted from diagnostics.

## State-transition tables

### Boot selection

| Current             | Event and guard                                            | Next                | Observable result                                                                                                      |
| ------------------- | ---------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `starting`          | Modern host ready and healthy before monotonic `t0+5000ms` | `modern-selected`   | `terminal.capabilities.backend="modern"`; shell creation opens.                                                        |
| `starting`          | Modern health fails or deadline expires before any shell   | `legacy-selected`   | Backend fixed to legacy for boot; persistent `Starting fallback: Copy diagnostics` notice; next launch retries modern. |
| `starting`          | Create requested before selection                          | `starting`          | `HOST_STARTING`; no shell is spawned.                                                                                  |
| `modern-selected`   | Host heartbeat/probe healthy                               | `modern-selected`   | Normal operation.                                                                                                      |
| `modern-selected`   | Host unhealthy after a shell exists                        | `modern-recovering` | Sessions become `failed` on confirmed host crash; one replacement host is attempted. No live path switch.              |
| `modern-recovering` | Replacement healthy                                        | `modern-selected`   | Existing sessions remain failed; user may create new sessions.                                                         |
| `modern-recovering` | Replacement fails or second crash                          | `modern-unhealthy`  | `BACKEND_RESTART_REQUIRED`; offer `Restart with legacy Terminal`.                                                      |
| any selected state  | App shutdown                                               | `stopped`           | Close barriers run in parallel, then host shutdown and cleanup ledger reaping.                                         |

The v1 recovery delay is 250 ms before the single replacement attempt. No
additional automatic host starts occur in that boot. This is the bounded
backoff and crash-loop limit.

### Host health and generation

| Current     | Event                                              | Next        | Required action                                                    |
| ----------- | -------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `starting`  | `ready` and first heartbeat                        | `healthy`   | Publish generation and zero or more active sessions.               |
| `healthy`   | Heartbeat absent for 750 ms                        | `degraded`  | Send one probe; do not kill shells.                                |
| `degraded`  | Heartbeat or probe within one second               | `healthy`   | Reset monotonic watchdog.                                          |
| `degraded`  | No response by one second                          | `unhealthy` | Mark all sessions failed with `host-crash`; begin one replacement. |
| `healthy`   | RSS exceeds baseline by 160 MiB for 30 seconds     | `unhealthy` | Reject creates; preserve responsive sessions; offer restart.       |
| any         | OS sleep/resume or confirmed event-loop suspension | same        | Pause watchdog; wall-clock jumps never cause a false crash.        |
| `unhealthy` | Replacement ready with `generation+1`              | `healthy`   | Stale old-generation messages fail closed.                         |
| any         | Host process exits                                 | `unhealthy` | Reap recorded trees, fail sessions, and apply replacement policy.  |

Heartbeat cadence is 250 ms. `hostGeneration` increments only on a new host.
Every session created after a generation change receives a new `sessionId`.

### Session lifecycle

| Current              | Event and guard                                              | Next       | Contract effect                                                                                   |
| -------------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| none                 | Policy, scope, profile, capacity, and backend checks pass    | `starting` | One capacity slot is reserved and an immutable launch snapshot is created; host `create` is sent. |
| `starting`           | Host `running` and containment established                   | `running`  | `session.create` returns; commands may be accepted after attach hydration.                        |
| `starting`           | Profile, containment, host, or protocol failure              | none       | Reservation is released; no session or tombstone is exposed; error returned.                      |
| `running`            | Input or resize command accepted                             | `running`  | Sequence and cumulative ack advance.                                                              |
| `running`            | User close, scope teardown, workspace reset, or app shutdown | `exiting`  | Close barrier is appended after all accepted commands; new input and resize reject.               |
| `running`            | Host reports natural exit                                    | `exiting`  | Flush output through `finalOutputSeq`.                                                            |
| `running`            | Confirmed host crash or containment loss                     | `failed`   | Preserve output and failure metadata; do not recreate automatically.                              |
| `exiting`            | Output and exit barrier complete                             | `exited`   | Tombstone retained; tab and capacity remain.                                                      |
| `exiting`            | Flush deadline or barrier fails                              | `failed`   | Tombstone marks failed exit; `EXIT_FLUSH_FAILED` remains visible.                                 |
| `exited` or `failed` | Explicit Terminal tab close                                  | none       | Tombstone and attachment are removed; capacity decrements.                                        |

### Attachment lease

| Current     | Event                                                             | Next                           | Effect                                                                                |
| ----------- | ----------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| none        | `attach` validates session, generation, and requested sequence    | `attaching`                    | New `attachmentEpoch = previous + 1`; prior lease is revoked.                         |
| `attaching` | Hydration chunks complete and renderer writes through final chunk | `attached`                     | Input enabled; `hydrationComplete` is acknowledged.                                   |
| `attaching` | Gap, stale generation, malformed checkpoint, or disconnect        | none                           | Renderer stays hidden; `REATTACH` or explicit gap action.                             |
| `attached`  | `detach` with reason `hide`, `switch`, or `disconnect`            | none                           | Delivery stops; shell remains live; checkpoint may be submitted after settled writes. |
| `attached`  | Input/output ack stalls for two seconds                           | none                           | Lease revoked; show `Input delivery unknown` or `Reconnecting`.                       |
| any         | A command or ack from a non-current ID/epoch                      | same                           | `STALE_ATTACHMENT`; no state mutation.                                                |
| any         | Session enters `exiting`                                          | `attached` until final barrier | Input disabled; output and exit barrier continue.                                     |

### Hydration and replay

| Inputs                                                                              | Result             | Renderer behavior                                                                      |
| ----------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `lastOutputSeq` is retained and contiguous; no checkpoint needed                    | `delta`            | Apply chunks after `lastOutputSeq`; preserve tail or anchor.                           |
| Valid checkpoint matches generation and following output is contiguous              | `checkpoint-delta` | Deserialize checkpoint, apply contiguous tail, then reveal.                            |
| Retained floor is after request, checkpoint stale/rejected, or continuity is broken | `reset-tail-gap`   | Reset renderer, apply retained tail, show `TerminalGap`, reveal only after completion. |
| Host generation differs                                                             | no hydration       | `STALE_HOST_GENERATION`; attach a new session only through create.                     |
| Session exited with retained tombstone                                              | same three choices | Exit metadata and final barrier are delivered after retained bytes.                    |

Server replay is byte-bounded and renderer-independent. A reduction in
scrollback evicts oldest bytes and emits a gap when the requested position is
lost. The renderer line limit is never treated as a promise of exact bytes.

### Tombstone and replacement

| Current           | Event                                | Next                         | Capacity and data                                                                      |
| ----------------- | ------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| `running`         | Natural exit or close barrier        | `exited`                     | Tombstone stores bounded checkpoint, replay tail, final seq, and exit metadata.        |
| `running`         | Host crash or contract failure       | `failed`                     | Same tombstone fields plus failure reason.                                             |
| `exited`/`failed` | User selects Replace/Start new shell | old remains; new `starting`  | A second slot is reserved; old tab and capacity remain until new session is `running`. |
| new `starting`    | Host confirms `running`              | old may close; new `running` | Replacement is the only event that permits removing the old tombstone.                 |
| new `starting`    | Any failure                          | old remains; new removed     | New reservation is released; old output and exit details remain visible.               |
| `exited`/`failed` | Explicit Close                       | removed                      | Capacity decrements only now.                                                          |

### Checkpoint upload

Each upload is at most 8,388,608 bytes across at most 128 chunks of 65,536
bytes. The client sends chunks without per-chunk acknowledgements; JSON
`terminal.session.checkpoint.complete` alone decides whether the upload installs
or aborts.

| Current     | Event and guard                                                               | Next        | Effect                                                           |
| ----------- | ----------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| none        | `checkpoint.begin` validates attachment, generation, sequence, size, hash     | `open`      | Upload identity issued; 10-second monotonic expiry starts.                         |
| `open`      | `checkpointChunk` index and payload stay within the declared bounds            | `open`      | Chunk retained in memory; no per-chunk acknowledgement is sent.                  |
| `open`      | `checkpoint.complete` finds every chunk present and hash/size match            | `installed` | Atomically replace checkpoint; expose `checkpointThroughSeq`.                    |
| `open`      | `checkpoint.complete` finds a missing chunk or hash/size mismatch              | `aborted`   | Discard upload and return `CHECKPOINT_REJECTED`; reattach and start a new upload. |
| `open`      | Timeout, disconnect, or invalid chunk                                           | `aborted`   | Do not replace prior checkpoint; reattach and start a new upload.                 |
| `installed` | Older or future checkpoint arrives                                             | `installed` | Ignore stale checkpoint; no replacement or success-shaped acknowledgement.       |

## Required sequence traces

The following traces are normative. `S` is server orchestration/runtime, `H` is
PTY host, `C` is renderer controller, and `R` is renderer/xterm.

1. **Create**: `C -> S session.create(scope,profile)`; `S` validates scope/profile/capacity; `S -> H create`; `H -> S containment + running`; `S` stores immutable snapshot; `S -> C session snapshot running`; `C -> S attach`; hydration completes before input.
2. **Attach**: `C -> S attach(lastOutputSeq,lastCommandSeq,checkpointSeq?)`; `S` revokes prior epoch, returns descriptor with `inputEnabled:false`; `S -> C hydration chunks`; `S -> C hydrationComplete`; `C -> S outputAck` after emulator writes through the final chunk; `S -> C state`; `C` enables input and reveals.
3. **Hide**: `C -> S detach(reason:hide)` after renderer writes settle; `C -> S checkpoint.begin/chunks`, then JSON `checkpoint.complete` as the sole upload authority; if it reports a missing chunk, `S` aborts the upload and `C` reattaches before starting a new one; otherwise `S` pauses delivery only; `H` continues output into replay; no lifecycle transition.
4. **Switch**: `C -> S detach(reason:switch)`; select new session; `C -> S attach`; `S` chooses delta/checkpoint/reset; `R` hydrates hidden; `C` restores tail or anchor; reveal after completion; old session remains live/headless.
5. **Reconnect with delta**: WebSocket reconnect; `C -> S session.list`; `C -> S attach(lastOutputSeq)`; retained sequence is contiguous; `S -> C delta`; `C` writes and cumulatively acknowledges; state returns `attached`.
6. **Reconnect with checkpoint**: attach includes validated `checkpointSeq`; `S` checks generation and checkpoint; `S -> C checkpoint-delta`; `R` restores checkpoint then tail; `C` acknowledges final output; reveal.
7. **Reconnect with gap**: attach asks for evicted sequence; `S -> C gap(firstMissing,lastMissing,retainedFloor)` plus retained tail; `R` resets, writes tail, displays gap; `C` enables input only after hydration; no byte is invented.
8. **Headless close**: `C -> S session.close` with no attachment; `S` appends close barrier after last accepted command; `S -> H close`; `H -> S exit(finalOutputSeq)`; `S` flushes replay and tombstone; response is `exited` or `failed`.
9. **Natural exit**: `H -> S exit(code,signal,finalOutputSeq)`; `S` enters `exiting`; flushes all output through final sequence; `S -> C exitBarrier`; `R` writes through final or shows gap; tombstone becomes `exited`.
10. **Host crash**: heartbeat/probe deadline; `S` marks host `unhealthy`; every live session becomes `failed` with `host-crash`; cleanup ledger reaps roots; one host replacement starts at `generation+1`; no old session is recreated or switched to legacy.
11. **Settings change**: `C -> S terminal.preferences.update` with presentation, behavior, or accessibility fields; `S` validates; font/cursor/ligature/accessibility and scrollback apply live; scrollback resize evicts old replay and emits gaps; profile/default changes affect only future creates; no PTY restarts.
12. **Profile deletion**: `C -> S profile.delete`; `S` checks global and workspace references; referenced profile returns `PROFILE_IN_USE`; otherwise settings write is atomic; existing sessions retain immutable launch snapshots.
13. **Workspace reset**: `C -> S workspacePreferences.reset`; `S` deletes one override row; existing sessions are unchanged; future creates resolve global default. Workspace deletion calls `closeScope` before database cascade.
14. **Startup fallback**: server starts modern selector; `S` waits monotonic five seconds while reporting `Starting`; health fails before any shell; selector fixes legacy for the boot; persistent notice offers `Copy diagnostics`; next launch starts modern selection again.
15. **Restart with legacy**: modern host fails after a shell exists; bounded replacement is exhausted; `S` marks unhealthy and returns `BACKEND_RESTART_REQUIRED`; UI offers `Restart with legacy Terminal`; user restarts current binary; new boot selects legacy only through startup selection, with no live-session migration.

## Current-to-target file and importer map

This map is based on repository `rg` results. The commands are reproducible at
the repository root and are part of the handoff evidence.

| Current file/symbol                                                                                                                                                           | Current importers or seams                                                                                                                                                                                                                         | Target disposition                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/terminal-service.ts:TerminalService`, `PtySender`, `create/write/resize/kill/pause/resume/reattach/checkpoint/listActiveSessions/hasChildren`       | `apps/server/src/index.ts`, `apps/server/src/container.ts`, `apps/server/src/transport/ws-router.ts`, `apps/server/src/services/cleanup-worker.ts`, `apps/server/src/services/thread-teardown-service.ts`, server terminal/workspace/cleanup tests | Move current implementation unchanged under `apps/server/src/terminal/legacy/`; modern callers use `TerminalSessionService` and `TerminalSessionRuntime`.                                                           |
| `apps/server/src/services/terminal-flow-control.ts:TerminalFlowControl` and tests                                                                                             | `terminal-service.ts`, `terminal-service.test.ts`, flow-control tests                                                                                                                                                                              | Move mechanics to `terminal/runtime/terminal-flow-control.ts`; legacy copy is imported only by `LegacyTerminalBackend`.                                                                                             |
| `apps/server/src/services/terminal-replay-buffer.ts:TerminalReplayBuffer`, `replayCapBytesForScrollback` and tests                                                            | `terminal-service.ts`, replay and terminal service tests                                                                                                                                                                                           | Move to `terminal/runtime/terminal-replay-buffer.ts`; enforce v1 hydration and gap descriptors.                                                                                                                     |
| `apps/server/src/services/pty-pid-registry.ts:PtyPidRegistry` and tests                                                                                                       | `terminal-service.ts`, container, startup cleanup                                                                                                                                                                                                  | Replace with `terminal/cleanup/terminal-cleanup-ledger.ts` and `reap-orphaned-terminals.ts`; retain only logical ID, generation, root PID, process-group identity.                                                  |
| `apps/server/src/services/windows-process-scope.ts`, `process-kill.ts`, `job-object.ts`                                                                                       | `terminal-service.ts`, provider/GitHub cleanup paths                                                                                                                                                                                               | Keep shared `job-object.ts` and `process-kill.ts`; move Terminal-specific scope into `host/platform/windows-pty-platform-adapter.ts`.                                                                               |
| `packages/contracts/src/ws/methods.ts` terminal methods at lines 960-1045                                                                                                     | `apps/server/src/transport/ws-router.ts`, `apps/web/src/transport/ws-transport.ts`, `apps/web/src/transport/types.ts`, contract tests                                                                                                              | Add strict v1 `ws/terminal.ts`; isolate existing methods in `ws/terminal-legacy.ts` until Stable removal.                                                                                                           |
| `packages/contracts/src/ws/terminal-binary.ts` u32 `ptyId` frame                                                                                                              | `apps/server/src/index.ts` sender, `transport/push.ts`, `apps/web/src/transport/ws-transport.ts`, `ws-events.ts`, terminal binary tests                                                                                                            | Add v1 envelope/codec with UUIDs and u64; legacy codec remains under `terminal/legacy/`.                                                                                                                            |
| `packages/contracts/src/ws/channels.ts` `terminal.data`/`terminal.exit`                                                                                                       | `apps/web/src/transport/ws-events.ts`, channel tests                                                                                                                                                                                               | Replace public push channels with attachment frames and typed state/exit frames; legacy channels remain isolated.                                                                                                   |
| `apps/server/src/transport/ws-router.ts` terminal cases 1099-1134                                                                                                             | `RouterDeps.terminalService` and all WebSocket clients                                                                                                                                                                                             | Route v1 management methods to `TerminalSessionService`; only `LegacyTerminalBackend` may call v0 methods.                                                                                                          |
| `apps/server/src/transport/push.ts:broadcastTerminalData`, `apps/server/src/index.ts:setSender`                                                                               | WebSocket and IPC push paths                                                                                                                                                                                                                       | Replace global PTY broadcast with attachment-scoped binary delivery from runtime; retain port push for non-terminal channels.                                                                                       |
| `apps/web/src/transport/ws-transport.ts` reconnect/listActive/reattach and terminal RPC methods                                                                               | `TerminalView`, reconnect tests, `ws-events.ts`                                                                                                                                                                                                    | Add `TerminalClient` adapters; modern adapter owns attach/hydration/ack; legacy adapter contains old names and `ptyId`.                                                                                             |
| `apps/web/src/transport/ws-events.ts`, `apps/web/src/components/terminal/ptyDataRegistry.ts`                                                                                  | `TerminalView`, `TerminalPoolHost`, transport tests                                                                                                                                                                                                | Remove global event bridge from modern path; attachment subscription delivers frames directly to `TerminalRendererController`.                                                                                      |
| `apps/web/src/stores/terminalStore.ts:MAX_TERMINALS_PER_SCOPE=4`, `TerminalInstance`, panel state                                                                             | `ensure-terminal.ts`, `RightPanel.tsx`, `ActivityRail.tsx`, `TerminalPanel*`, status indicators, tests                                                                                                                                             | Store discriminated modern session handles, tombstones, recovery, and app-wide `sessionLimit` (default 20). Remove per-scope cap logic.                                                                             |
| `apps/web/src/lib/ensure-terminal.ts`                                                                                                                                         | Right-panel add flows and tests                                                                                                                                                                                                                    | Call `terminal.session.create`; map `SLOT_LIMIT_REACHED` to app-wide capacity UI.                                                                                                                                   |
| `apps/web/src/components/terminal/TerminalView.tsx`                                                                                                                           | focus/scroll/flow-control tests, panel components                                                                                                                                                                                                  | Split into `TerminalRendererController.tsx` and `XtermTerminalRenderer.tsx`; strengthened xterm remains selected.                                                                                                   |
| `apps/web/src/components/terminal/TerminalPoolHost.tsx`, `TerminalPanel.tsx`, `TerminalTabContent.tsx`, `TerminalList.tsx`, `TerminalToolbar.tsx`                             | `App.tsx`, `RightPanel.tsx`, terminal component tests                                                                                                                                                                                              | Keep `TerminalPoolHost` only as the one-controller mount host; delete `TerminalPanel`, `TerminalTabContent`, `TerminalList`, and `TerminalToolbar`; preserve the right-panel product tab model in `RightPanel.tsx`. |
| `apps/server/src/services/cleanup-worker.ts`, `thread-teardown-service.ts`, workspace hard-delete paths                                                                       | cleanup and workspace tests                                                                                                                                                                                                                        | Call `TerminalSessionService.closeScope(scope)`; remove public `killByThread`.                                                                                                                                      |
| `apps/server/src/container.ts`, `apps/server/src/index.ts`                                                                                                                    | DI, sender wiring, shutdown and desktop busy state                                                                                                                                                                                                 | Register selector, service, runtime, host supervisor, diagnostics, profile/preference services, and cleanup ledger; shutdown through `closeScope` and host supervisor.                                              |
| Existing terminal tests under `apps/server/src/services/__tests__`, `apps/web/src/__tests__`, `apps/web/src/components/terminal/__tests__`, `apps/desktop/src/main/__tests__` | Current behavior protection                                                                                                                                                                                                                        | Port to contract, in-memory host, real PTY, renderer controller, import-boundary, and packaging suites without weakening assertions.                                                                                |

### Reproducible `rg` evidence

```text
rg -n "TerminalService|terminalService|killByThread|terminal\\.create|terminal\\.write|terminal\\.resize|terminal\\.reattach|terminal\\.checkpoint" apps packages
rg -n "ptyDataRegistry|emitPtyData|emitPtyExit|TerminalPoolHost|TerminalPanel|TerminalTabContent|TerminalList|TerminalToolbar" apps/web/src
rg -n "broadcastTerminalData|terminalService\\.setSender|terminalService\\.onBufferedAmountTick" apps/server/src
rg -n "MAX_TERMINALS_PER_SCOPE|terminalCreate|terminalKill|reconcileActiveSessions" apps/web/src
```

The current hits establish the importer set above: `TerminalService` is wired
through `index.ts`, `container.ts`, `ws-router.ts`, cleanup worker, and thread
teardown; current binary and push paths are `terminal-binary.ts`, `push.ts`,
`ws-transport.ts`, and `ws-events.ts`; and the client cap is enforced by
`terminalStore.ts`, `ensure-terminal.ts`, `RightPanel.tsx`, and
`ActivityRail.tsx`.

## Verification obligations

The implementation must preserve the following evidence gates. A contract pack
is not an implementation result; each obligation becomes a maintained test or
release artifact in the corresponding implementation PR.

### Contract and boundary tests

- Strict schemas reject unknown keys, malformed UUIDs, invalid scopes, noncanonical U64 values, dimensions outside bounds, oversized commands, payloads, profiles, settings, diagnostics, and checkpoint uploads.
- Binary codec tests cover every frame kind, round trips, truncation, trailing bytes, wrong magic/version/kind/flags, wrong ID lengths, sequence overflow, payload overflow, duplicate bytes, generation/attachment mismatches, and checkpoint chunks without per-chunk acknowledgements.
- Host protocol tests cover every server and host message, heartbeat cadence, malformed messages, stale generations, `inspectChildren` generation validation, duplicate output, and bounded payloads.
- Error-mapping tests assert every operation-specific set and retry class in this document, including unknown-delivery handling.

### Runtime and persistence tests

- In-memory `PtyHostAdapter` tests cover every lifecycle transition, command ordering, resize latest-wins behavior, cumulative acknowledgements, 256 KiB input stall, two-second acknowledgement revocation, output watermarks, replay eviction, checkpoint replacement, hydration choices, gaps, tombstones, replacement failure, close barriers, natural exit, host crash, and shutdown.
- Real ConPTY and POSIX PTY tests cover create, input, output, resize, child inspection, graceful close, forced close, host crash, and descendant cleanup through the supervised host seam.
- Profile tests cover certified detection, Automatic resolution, custom bounds, missing executables, references, immutable launch snapshots, and one-time profile choice.
- Settings migration tests cover legacy flat fields, scrollback mapping `0 -> 5000`, `1..99 -> 100`, `100..5000` unchanged, and `>5000 -> 5000`, backup preservation, idempotence, atomic writes, malformed input, future versions, reset, workspace inheritance, rename survival, and deletion cascade.
- Cleanup-ledger tests prove process identity checks, generation checks, bounded record count 20, startup reaping, scope close, and no native handle leakage.

### Web, desktop, and accessibility tests

- Transport tests cover capability selection before state hydration, modern and legacy adapter isolation, reconnect delta/checkpoint/gap, attach races, stale frames, input delivery unknown, and restart-with-legacy state.
- Renderer-controller tests cover one mounted xterm, hidden hydration, tail and reading anchors, checkpoint submission, output acknowledgements, resize ordering, search Shelf state per session, links, clipboard, IME commit-only behavior, screen-reader transcript, focus, keyboard resize, and reduced motion.
- Live checks exercise the right-panel Terminal at wide, constrained, and narrow postures; create 20 sessions across scopes; reject the 21st with `SLOT_LIMIT_REACHED`; preserve exited tabs and tombstones; hide, switch, reconnect, close headless, and apply settings without PTY restart.
- Certified shells are exact per target: Windows PowerShell 5.1, PowerShell 7, cmd, Git Bash, WSL when installed; macOS zsh and bash; Linux bash and zsh. Optional workloads explicitly skip only when unavailable outside release images.

### Quality and release evidence

- Deterministic VT fixtures are semantic authority for cell grids, sequences, reflow, clipping, input encoding, protocols, replay, and exit barriers.
- Real-shell workloads exercise PSReadLine, vim, less, tmux, fzf, and top where the target image provides them.
- Apply the fixed p95/p99 latency, throughput, memory, restoration, resize, input, accessibility, process, packaging, and 30-run gates from [What measurable quality gates define a native-feeling Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1076).
- Use packaged artifacts and offline smoke from [What exact packaging and CI changes ship the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1105). Record target manifests, hashes, Electron/Node/native versions, shell versions, workload IDs, distributions, faults, 30-run counts, smoke, performance, and accessibility sign-off. Retain raw evidence 90 days and the summary manifest permanently.
- Run `bun run verify` after each completed implementation PR series. Documentation-only edits to this pack do not require the code verification gate.

## Reconciliation obligations for the next Wayfinder ticket

The next Wayfinder ticket, Reconcile the terminal handoff with Mcode’s canonical
contracts, must reconcile, in one reviewed change set, the following existing
repository contracts with this freeze:

1. Update `CONTEXT.md` terminal cardinality wording from four per scope to one app-wide configurable limit default 20, and state that exited tabs/tombstones count until close or replacement reaches `running`.
2. Add the v1 `terminal` settings shape, `sessionLimit`, bounded scrollback, workspace preference row, and migration semantics to the canonical settings reference and migration guide without changing unrelated settings.
3. Replace architecture tables that name `TerminalService`, v0 RPCs, u32 frames, global `terminal.data`, and automatic tab removal with the selector, runtime, host, v1 transport, and tombstone behavior.
4. Add the forward-only `workspace_terminal_preferences` migration and versioned cleanup ledger described by [What settings schema and persistence contract should the modernized Terminal use?](https://github.com/Mzeey-Empire/mcode/issues/1088) and [What exact modules and interfaces implement the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1104).
5. Implement the packaging and CI mechanics in [What exact packaging and CI changes ship the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1105): one signed `mcode-server` host bundle, native artifact attestation, exact target matrix, offline PTY smoke, expected-fault lanes, manifests, and legacy absence checks.
6. Follow [What implementation sequence delivers the modern Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1106) and its checkpoints. Contracts and import fences merge before host/runtime work; activation changes selection only; legacy removal precedes Stable.
7. Preserve the strengthened xterm decision and add the release-blocking renderer/accessibility evidence from [What measurable quality gates define a native-feeling Terminal?](https://github.com/Mzeey-Empire/mcode/issues/1076) and [Which renderer should Mcode adopt?](https://github.com/Mzeey-Empire/mcode/issues/1078). No renderer substitution is permitted.

These are reconciliation tasks, not open design choices. They do not
permit changing the bounds, discriminants, state tables, traces, or retry rules
in this document without a new contract version and an updated audit.

## Implementation-readiness statement

This artifact proves implementation can begin because every public operation,
binary frame, private host message, state transition, sequence trace, bound,
ownership rule, error set, retry class, unknown-delivery rule, importer seam,
and verification obligation is concrete. An implementer can create the strict
schemas and codecs, build the runtime and host adapters behind the named seams,
port current importers, and write failing contract tests without inventing a
field, transition, capacity rule, fallback path, or recovery meaning. The only
remaining work is execution of the reconciled implementation and packaging
obligations above, not a deferred contract decision.
