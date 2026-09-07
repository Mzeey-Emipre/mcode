# Bun Runtime Migration

## Status

The Bun backend, Bun SQLite driver, and Electron PTY host are implemented. Development, agent, and packaged launchers select Bun for `server.cjs` and select Electron explicitly for `pty-host.cjs`. The direct Bun ConPTY result remains a compatibility finding, not a backend blocker, because terminal `node-pty` and PTY containment run in the Electron host. The server still uses its compatible `koffi` Job Object integration.

The Windows x64 disposable package proof passed. It used a compiled `mcode-bun.exe`, a separate `mcode-server.exe` Electron host, and a fixture terminal. The remaining release gate is a clean native rebuild on a Windows packaging machine with Visual Studio. This workspace cannot run it because the required Visual Studio build tools are absent. macOS signing and notarization of `mcode-bun` require a macOS release environment.

## Assessment

Bun 1.4.0 is the workspace package manager and runs project scripts. Read-only probes passed for an in-memory `bun:sqlite` database, `reflect-metadata`, module loading for `node-pty` and `koffi`, and Windows `CreateJobObjectW` plus `CloseHandle` through `koffi`.

Those probes do not prove server compatibility. A Bun-hosted `node-pty` probe started `cmd.exe`, wrote a marker, and requested resize. It received no output and timed out. The timeout kill exited with `-1073741510`. This records the tested ConPTY failure on this machine. It does not claim that all Bun and node-pty combinations fail.

The current server admission policy now selects its measurement by runtime. Electron keeps V8 used heap divided by V8's heap limit. Bun 1.4.0 reported a `node:v8` heap limit of 216,678,400 bytes while V8-compatible used heap stayed near 0.6 MiB after a 4 MiB allocation. It is not a reliable Bun budget. Bun instead measures the server process's RSS against `server.memory.heapMb` as a soft budget. Warning begins at 80%, critical begins at 90%, critical rejects new turns, and existing provider shedding remains active. This budget does not cap Bun's allocator, provider child processes, or the Electron PTY host. RSS can retain released pages, so it is deliberately conservative.

The completed persistence migration retained durable SQLite pragmas, migration backups, migration recovery, and existing database files while replacing the Electron-native driver and binding gate with Bun SQLite.

## Runtime boundary

| Component | Current runtime | Target | Status |
| --- | --- | --- | --- |
| Desktop shell | Electron | Electron | retained |
| Backend server | Bun | Bun | complete |
| Isolated PTY host | Electron Node mode | Electron Node mode | explicit executable provenance complete |
| Terminal containment | Electron PTY host | Electron PTY host | retained |
| SQLite | Bun SQLite driver | Bun SQLite driver | complete |

The PTY host uses JSON IPC, reports Electron's native ABI, owns `node-pty`, `koffi`, resize, cleanup, and Windows Job Objects. `dev-web.mjs`, `agent-up.mjs`, desktop server startup, and packaged smoke startup set `MCODE_PTY_HOST_EXECUTABLE`. The packaging terminal-artifact attestation launches the host directly with its chosen runtime and does not launch `server.cjs`. The desktop dev and performance harnesses reach server startup through the desktop runtime or `agent-up.mjs` and have no separate server spawn to change.

## Remaining release gates

1. Run a clean Windows native rebuild with the required Visual Studio build tools, then package and rerun the native artifact, Bun health, and fixture-terminal proofs.
2. Run a signed macOS package proof. `mcode-bun` is listed with `mcode-server` for macOS signing.
3. Run the existing release pipeline on all supported targets. The Bun compiler accepts the Windows x64 and arm64 targets, but this Windows workspace only exercised x64.

## Verification evidence

Compatibility probes used Bun 1.4.0. `bun --bun node_modules/vitest/vitest.mjs run src/features/terminal/host/__tests__/pty-host-child.test.ts` passed in `apps/server`. The Bun ConPTY probe failed as described above. The native Job Object probe and the existing Electron-hosted PTY integration tests passed.

The SQLite migration replaced `better-sqlite3` and its Drizzle driver with `bun:sqlite` and `drizzle-orm/bun-sqlite`. The immutable preservation receipt `.dev/verification/bun-sqlite-preservation-20260907.receipt.json` records all 42 source tables and `PRAGMA integrity_check = ok`. Its companion `.dev/verification/bun-sqlite-preservation-diff.receipt.json` records unchanged original-column row and content digests, plus the expected migration 0059 approval columns and journal 60 to 61. Backup and recovery tests cover WAL snapshots, injected migration failures, sidecar cleanup, and bounded backup retention.

The final Windows x64 disposable package was built with `npmRebuild: false` only in `.dev/package-bun-stage`. Release configuration still requests native rebuilds. The build log is `.dev/verification/package-bun-stage-final.log`. It staged `resources/bin/mcode-bun.exe` and the separate Electron `resources/bin/mcode-server.exe`. The package smoke command exited 0 after compiled Bun health and a passing fixture terminal, recorded in `.dev/verification/package-smoke-final.log`. Its child server later logged exit code 1 because the smoke script intentionally sent `SIGTERM` during cleanup; it is recorded separately in `.dev/verification/package-smoke-final.err.log`. `.dev/verification/package-bun-native-attestation.json` records the Electron 35.7.5 ABI 133 native inventory and hashes. The attestation command passed host-handshake validation for the explicit PTY host. The public package terminal receipt `.dev/verification/packaged-bun-legacy-terminal-receipt.json` records fixture-only legacy RPC creation, observed `120x30` dimensions, computed output `585987`, and close cleanup. A compiled Bun process sets `process.argv[1]` to its executable, so the host resolver now uses `MCODE_PACKAGED_RESOURCES_ROOT` for the unpacked `pty-host.cjs` path.

The Bun memory probe used the production sampler with a 256 MiB budget. It measured process RSS from 21,688,320 to 24,207,360 bytes after a bounded 2 MiB allocation, producing a ratio of `0.090179443359375`. The receipt is `.dev/verification/bun-memory-sampler-receipt.json`. Bun's independent `bun:jsc.memoryUsage().current` reported the same final measurement. The sampler reports `process-rss` for Bun and `v8-heap` for Electron and Node. `bun run --cwd apps/server test -- src/runtime/memory/__tests__/memory-pressure-service.test.ts src/runtime/memory/__tests__/runtime-memory-sampler.test.ts` passed 11 tests with exit code 0. The tests cover the bytes immediately below and at the warning and critical thresholds, critical admission rejection, recovery after a saved budget update, V8 preservation, invalid Bun budgets, listener transitions that drive the retained provider shedding dispatch, and a bounded Bun subprocess importing the production sampler. `bun run --cwd apps/server typecheck` and targeted `bunx --no-install oxlint` passed with exit code 0.

Final focused checks passed with exit code 0: `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/server typecheck`, and `bunx --no-install oxlint` for each changed source file after building the local Oxc plugin. `bun run --cwd apps/desktop test -- src/features/server-runtime/process/__tests__/manager.test.ts` passed 60 tests. `bun run --cwd apps/server test -- src/features/terminal/host/__tests__/pty-host-child.test.ts` passed 3 tests. `bun run --cwd apps/server test -- src/features/terminal/host/__tests__/pty-host-supervisor.real.test.ts` passed in 40.78 seconds.

`bun scripts/build-server-dev-bundle.mjs` passed after this boundary change. `bun run agent:setup`, `bun run --shell system agent:up`, `bun run agent:ready`, then the runtime health verifier passed with the launcher environment. The runtime check command produced no result within 60 seconds and was stopped, so it is not acceptance evidence.

### Live production-snapshot verification

`bun run --shell system agent:down`, then `bun run agent:setup` completed with exit code 0 before testing. Setup copied the authorized production database into `.dev/db/app.sqlite`. The redacted receipt at `.dev/verification/bun-migration-prod-seed-receipt.json` records `PRAGMA integrity_check = ok` for source and copy, with matching counts of 16 workspaces, 372 threads, and 2,780 messages. The source database remained read-only.

The test desktop owns a separate database at `.dev/electron-agent-runtime/runtime/db/app.sqlite`. With owned processes stopped, `bun scripts/db-seed.mjs --source .dev/db/app.sqlite --target .dev/electron-agent-runtime/runtime/db/app.sqlite` copied the workspace snapshot into that database. Both had `PRAGMA integrity_check = ok` and matching counts of 17 workspaces, 385 threads, and 2,777 messages. The redacted desktop receipt is `.dev/verification/bun-migration-desktop-receipt.json`.

`bun run --shell system agent:up --desktop`, `bun run agent:ready`, and the runtime health verifier completed with exit code 0. The desktop selected a copied completed thread in a copied workspace. A rendered persisted message body had the same hash before and after a browser reload. The receipt records only IDs, the hash, and boolean results. `.dev/verification/bun-migration-production-history-masked.png` is a masked screenshot of that view. This proves stable desktop rendering of one copied history item. It does not prove raw stored content equals rendered Markdown.

The public runtime API created a direct conversation in `.dev/fixture-repo` and a fresh authenticated connection found it after reconnect. `.dev/verification/bun-migration-fixture-persistence-receipt.json` records that proof. It made no provider request and did not mutate production-derived records.

Terminal compatibility passed for the current Electron-hosted modern path. With `MCODE_TERMINAL_BACKEND=modern`, one fixture-scoped session reached running state, subscribed and acknowledged hydration, resized to `120x30`, reported those dimensions from PowerShell, emitted the computed marker `585987`, and closed. The proof used the repository's modern client and records no terminal content. It ran after the final rebuild against the managed Bun child recorded as PID 8820 in `.dev/verification/bun-migration-final-desktop-receipt.json`; the terminal receipt is `.dev/verification/bun-migration-modern-terminal-receipt.json`.

Legacy terminal compatibility also passed through the current Electron PTY host. The legacy service now uses the same DI-owned host as the modern backend. It retains legacy replay and flow control while awaiting host startup and commands. It filters Windows environment keys that the existing modern host boundary excludes, including `ProgramFiles(x86)` and `CommonProgramFiles(x86)`. Close waits for accepted commands, rejects commands after close begins, and keeps host sequence numbers ordered. User close force-terminates a POSIX process group. App shutdown follows SIGHUP, SIGTERM, then SIGKILL only if the process group remains alive. A fixture-scoped PowerShell session created through public legacy RPC resized to `120x30`, reported those dimensions, emitted computed marker `585987`, and cleared from `terminal.listActive` after close. The proof used freshly rebuilt `apps/desktop/dist/server/server.cjs` and `pty-host.cjs`; its receipt is `.dev/verification/bun-migration-legacy-terminal-receipt.json`.

After the final lifecycle changes, `bun run --cwd apps/server typecheck`, targeted `bunx --no-install oxlint`, and the seven-file focused Vitest command passed with exit code 0 and 77 tests. The suite covers replay, checkpoint replay, active-create limits, failed host startup cleanup, the Windows environment filter, host command ordering, rejected close retention, exit cleanup, headless retention, delayed host creation cleanup, graceful host shutdown, Windows Job Objects, and POSIX force and graceful close paths.

The initial snapshot receipt has 2,780 messages. Its original row-ID manifest was not retained before that test copy was replaced, so the exact historical three-row difference cannot now be attributed. A later immutable source snapshot had 2,735 messages. Its redacted ID and content-hash manifest was copied to an isolated test database, then subjected to one `agent:up`, `agent:ready`, and `agent:down` cycle. It had zero removed IDs, zero changed content hashes, and one added empty assistant record on an already interrupted copied thread. The startup log records interrupted-execution recovery. This is fresh preservation evidence for current startup code, not an explanation of the historical three-row difference. No code repair is justified without a reproducible loss.

## Release limitations

No dual SQLite driver or PTY fallback exists. The application build uses Bun for the backend and SQLite, then uses Electron only for desktop and native PTY containment. The Windows x64 package evidence uses prebuilt native artifacts with target-matched Electron 35.7.5 and ABI 133. It does not replace the clean-rebuild release gate.
