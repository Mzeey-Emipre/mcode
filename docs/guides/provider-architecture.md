# Provider Architecture Convention

All agent providers must use a **persistent process per session**, not per-turn spawning.

## Shared lifecycle: SessionRuntime + ProtocolAdapter

The uniform session lifecycle lives privately in `packages/providers`.
Each Provider holds its own `SessionRuntime<TState>` and implements
`ProtocolAdapter<TState>` (composition, not inheritance). The runtime owns the
session pool, the lazy 60s idle-eviction timer with a `lastUsedAt + isBusy`
guard, Windows `JobObject` attachment, the `EnvService` env snapshot, and the
graceful-interrupt-then-`taskkill /T /F` hard close — acting on the child PIDs
the adapter's `spawn` surfaces. The adapter supplies only `spawn`, `isBusy`,
`interrupt`, `close`, and `isStale`.

When adding a Provider, implement the `ProtocolAdapter` seam on the Provider
class and construct a `SessionRuntime` in its constructor; the pool, eviction,
JobObject, and hard-kill come for free. Do not hand-roll a session map or an
eviction timer. If the SDK hides the subprocess PID, return an empty `pids`
array from `spawn` and the runtime's JobObject/taskkill become best-effort
no-ops for that Provider (document it).

Both the Claude and Codex providers were originally built with per-turn process spawning
(via their respective SDKs). Both suffered the same reliability issues: stdin pipe timing
failures on Windows, abort signal races, and opaque error messages from stderr status lines
masking the real failure. Both were rewritten to use persistent processes.

When adding a new provider:

- Spawn one long-lived child process per session
- Communicate via stdin/stdout (JSON-RPC, NDJSON, or equivalent streaming protocol)
- Use graceful interruption (RPC call like `turn/interrupt`) before hard process kill
- On Windows, use `taskkill /T /F /PID <pid>` via execFile (not exec) for process tree
  cleanup - Node's `child.kill()` does not kill grandchildren on Windows
- Never pass `AbortSignal` directly to `spawn()` - manage cancellation via protocol-level
  interruption, not OS signals
- Guarantee `ended` event emission in every exit path (clean completion, error, crash, timeout)
- Filter stderr: classify lines as benign (debug log) or fatal (session teardown), never
  surface raw stderr as user-facing error messages

## Event boundary

A provider emits a `ProviderRuntimeEvent`. Its `event` is provider-neutral data
that may reach the renderer. Its optional extension contains provider-native
evidence that must not reach the renderer.

The server accepts runtime events in this order:

```text
Provider runtime event → provider ingress → provider adapter → turn event pipeline → AgentEvent
```

Ingress validates the provider identity, queues the event, and preserves its
receipt when it came from a canonical commit. An adapter may forward a generic
event, consume private provider work, or reject malformed native evidence with
a diagnostic. Only a forwarded `AgentEvent` enters narration, lifecycle, and
renderer publication.

Codex collaboration evidence uses a Codex adapter. Claude, Cursor, and Copilot
send generic runtime events and do not invoke that adapter. A new provider adds
an adapter only when it has private native evidence that requires server-side
projection.

Canonical commits hand their committed runtime envelopes directly to ingress.
The resulting receipt means durable acceptance or queueing. It never means that
the event was published to the renderer.

`AgentService` owns provider selection and narrow parent-turn durability. It
does not import a concrete provider, a provider adapter, or a canonical
implementation.
