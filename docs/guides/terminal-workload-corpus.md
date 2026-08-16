# Terminal workload corpus

The corpus gives terminal design tickets one repeatable input set. It runs real
child processes through node-pty, records the byte stream and resize trace,
and reports bounded lifecycle facts. It does not choose a renderer or change
the PTY transport.

Run the complete corpus from the repository root. Windows defaults to the
current Mcode PTY option shape:

    node --experimental-strip-types apps/server/scripts/run-terminal-workload-corpus.ts --json

Run one scenario while iterating:

    node --experimental-strip-types apps/server/scripts/run-terminal-workload-corpus.ts --workload reconnect-recovery --json

On Windows, run the native ConPTY isolation mode when the default adapter fails
before producing workload markers:

    node --experimental-strip-types apps/server/scripts/run-terminal-workload-corpus.ts --windows-pty native --json

`--windows-pty` accepts only `mcode` or `native` and is rejected on other
platforms. The report records `ptyMode` as `mcode`, `native`, or
`platform-default`.

The command prints one JSON report. A non-zero exit means a marker was missing,
the output or duration budget was exceeded, a resize limit was exceeded, or a
child process remained alive after termination. The report includes a normalized
SHA-256 digest. It replaces platform line endings and the process-cleanup child
PID so renderer comparisons can use the same digest input.

Each plan declares a synchronization marker. The runner waits for that marker
within the shared duration budget before applying dependent writes, resizes, or
disconnects; an already completed high-output child is accepted when its marker
was captured before exit.

## Scenarios and decision facts

| Scenario | Workload evidence |
| --- | --- |
| wrong-width-restoration | 80x24 to 120x24 to 80x24, cursor movement to row 24, and a marker after the width is restored. |
| jagged-reflow | A long line containing wide, combining, and emoji graphemes while widths 39, 40, and 41 are applied. |
| shaky-live-resizing | Six resizes while 15ms ANSI-colored output continues. |
| bottom-row-clipping | Writes on row 24, then row 8 after resize, followed by a post-cursor marker. |
| high-output-pressure | Twenty numbered 4KiB chunks, with a 128KiB total output cap. |
| reconnect-recovery | Detach during a live PTY, count bytes missed while detached, then capture a post-gap marker without respawning. |
| interactive-program | A real line-oriented child receives ping and exit and must produce pong and done. |
| process-cleanup | A PTY-owned parent reports a real child PID. The runner checks that the child is gone after PTY termination. |

Every scenario starts at 80 columns by 24 rows. The corpus bounds columns at
140, rows at 40, resizes at 12 per run with at least 10ms between resize
requests, output at 128 KiB, run time at two seconds, replay evidence at
32 KiB, and process cleanup at three seconds.
Those limits are test inputs, not product quality gates. Later tickets should
compare renderer output, resize latency, replay fidelity, and cleanup results
using the same workload IDs.

## Windows adapter fact

The default `mcode` mode passes `useConptyDll: true`, matching
`TerminalService`. In this development runtime, that adapter can stop after
the ConPTY setup bytes (23 bytes and no workload markers). That is
an adapter-launch fact for this exact host and runtime matrix, not a claim that
the application fails on every Windows installation.

The `native` mode passes `useConpty: true` without the bundled DLL and is the
isolation run for the workload machinery. It exercises all eight scenarios in
this environment. The process-cleanup case may leave a node-pty
`AttachConsole failed` diagnostic on stderr while still reporting its markers,
observed exit, and child cleanup in JSON; keep that diagnostic as evidence for
the PTY ownership ticket.

The maintained Windows integration command uses a Node host with the native
mode. In this development environment, both Bun and Node hosts fail before
markers in `mcode` mode with the same 23 setup bytes. Bun with native mode
passes high-output pressure but its interactive write closes the PTY socket;
Node with native mode completes all eight scenarios. These are bounded corpus
observations for this host and runtime matrix, not universal product claims.

The reusable plans and pure result evaluator live in
apps/server/src/features/terminal/testing/terminal-workload-corpus.ts. The CLI is a thin
node-pty consumer, so a server, renderer, or future comparison harness can
reuse the same workload mechanics without copying fixture logic.
