# Provider Architecture Convention

All agent providers must use a **persistent process per session**, not per-turn spawning.

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
