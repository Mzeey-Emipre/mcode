# Mcode Test Coverage: Design Spec

## Goal

Bring test coverage from ~20% to 80%+ using a risk-prioritized approach. Backend-first for shipping confidence, then fill frontend gaps.

## Approach

**Strategy:** Risk-prioritized (Approach 2 from brainstorming). Test the most dangerous untested paths first, regardless of layer.

**Test types:** Integration tests for anything touching I/O (SQLite, git, filesystem). Unit tests for pure logic.

| Priority | Module | Risk | Type |
|----------|--------|------|------|
| 1 | Repository CRUD | Data loss/corruption | Integration (real SQLite) |
| 2 | AppState.createThread rollback | Orphaned records | Integration (real DB, mock worktree) |
| 3 | AppState.sendMessage validation | Silent state corruption | Integration (real DB, mock sidecar) |
| 4 | Worktree validateName | Path traversal security | Unit |
| 5 | SidecarClient event emission | Broken event pipeline | Unit (mock SDK query) |
| 6 | Frontend utilities + stores | Coverage gap to 80% | Unit |

## Test Infrastructure

### Desktop Vitest Config

New file: `apps/desktop/vitest.config.ts`

- Environment: `node` (not jsdom; exercises native modules like better-sqlite3)
- Test pattern: `src/main/__tests__/**/*.test.ts`
- Module resolution: match `tsconfig.json` paths
- No special transforms needed (Bun + Vitest handle TypeScript natively)

### Shared DB Helper

New file: `apps/desktop/src/main/__tests__/helpers/db.ts`

Exports `createTestDb()` which calls `openMemoryDatabase()` from `store/database.ts`. Every integration test gets a fresh in-memory SQLite instance. No teardown needed (garbage collected).

### Test File Convention

- Backend: `apps/desktop/src/main/__tests__/<module>.test.ts`
- Frontend: `apps/web/src/__tests__/<module>.test.ts` (existing pattern)
- Root `bun run test` runs both via Turbo workspace pipeline

## Priority 1: Repository Integration Tests

### File: `apps/desktop/src/main/__tests__/repositories.test.ts`

All tests use a real in-memory SQLite instance via `createTestDb()`.

### Workspace Repo

| Test | Validates |
|------|-----------|
| Create workspace, verify fields and UUID generation | Basic CRUD, ID format |
| `findById` returns null for nonexistent ID | Null safety |
| `findByPath` finds by path | Lookup correctness |
| Duplicate path throws (UNIQUE constraint) | Schema constraint enforcement |
| `listAll` returns descending by `updated_at` | Sort order |
| `remove` deletes workspace | Delete correctness |
| `remove` cascades to threads via FK | Foreign key enforcement |

### Thread Repo

| Test | Validates |
|------|-----------|
| Create thread, verify `session_name` is `mcode-{uuid}` | Session naming contract |
| `listByWorkspace` excludes soft-deleted threads | Soft delete filter |
| `listByWorkspace` limit: 0 or negative clamped to 1 | Clamp lower bound |
| `listByWorkspace` limit: >1000 clamped to 1000 | Clamp upper bound |
| `softDelete` sets `deleted_at` and status to "deleted" | Soft delete mechanics |
| `hardDelete` removes the row entirely | Hard delete |
| `updateModel` returns true on success, false for nonexistent ID | Update correctness |
| `updateTitle` returns true on success, false for nonexistent ID | Update correctness |
| `updateWorktreePath` returns true on success, false for nonexistent ID | Update correctness |
| `updateStatus` transitions correctly | Status machine |

### Message Repo

| Test | Validates |
|------|-----------|
| Create message, verify sequence and fields | Basic CRUD |
| `listByThread` returns ascending order | Sub-select pattern correctness |
| `listByThread` limit: 0 or negative clamped to 1 | Clamp lower bound |
| `listByThread` limit: >1000 clamped to 1000 | Clamp upper bound |
| `parseJsonField` via malformed `tool_calls` column: insert row with bad JSON, verify `listByThread` returns null for that field | Graceful JSON failure |
| `parseJsonField` via valid `tool_calls` column: insert row with valid JSON, verify parsed object | JSON parse correctness |
| `parseJsonField` via null `tool_calls` column: verify null passthrough | Null passthrough |

Note: `parseJsonField` is not exported. Test it indirectly by inserting rows with controlled `tool_calls`/`files_changed` values via `db.prepare().run()` and verifying `listByThread` output.

## Priority 2-3: AppState Integration Tests

### File: `apps/desktop/src/main/__tests__/app-state.test.ts`

Uses real in-memory DB. Mocks: `worktree.ts` functions (vi.mock), `SidecarClient` (vi.mock or manual stub). Does NOT mock repositories (they hit the real DB).

**Setup note:** Tests that exercise sidecar interactions must call `appState.startSidecar()` first (with the SidecarClient module mocked). The mock SidecarClient should implement `sendMessage`, `stopSession`, and `shutdown` as vi.fn() stubs. For `sendMessage` cwd validation tests, use a real temp directory for the happy path or mock `fs.existsSync`/`fs.statSync` for error cases.

### createThread Tests

| Test | Validates |
|------|-----------|
| Direct mode: creates thread without calling createWorktree | Mode routing |
| Worktree mode: calls createWorktree, persists worktree_path | Happy path |
| Worktree failure: DB record is hard-deleted on createWorktree throw | Rollback safety |
| Worktree mode with nonexistent workspace: hard-deletes DB record and throws | Workspace lookup failure rollback |
| Rejects empty branch name | Input validation |
| Rejects branch >250 chars | Input validation |
| Rejects invalid branch chars (`~`, `^`, `:`, `?`, `*`, `[`, `]`, `\t`, `..`, leading `-`, spaces) | Input validation (parameterized) |
| Rejects unknown mode (not "direct" or "worktree") | Mode validation |

### sendMessage Tests

| Test | Validates |
|------|-----------|
| Happy path: persists user message, marks thread active, calls sidecar | Core flow |
| Rejects deleted thread (status or deleted_at) | Dead thread guard |
| Rejects missing workspace | FK integrity |
| Rejects invalid cwd: non-absolute path | Path validation |
| Rejects invalid cwd: nonexistent directory | Path validation |
| Rejects invalid cwd: path is a file, not a directory | Path validation |
| Rejects when sidecar not started, reverts status to "paused" | Precondition check |
| Sidecar throw: reverts thread status to "paused" | Error rollback |
| Resume detection: pre-insert a message in DB, then sendMessage; verify sidecar called with resume=true | Session continuity |
| Persists model via ThreadRepo.updateModel | Model tracking |

### stopAgent Tests

| Test | Validates |
|------|-----------|
| Calls sidecar.stopSession with correct session ID (`mcode-{threadId}`) | Session ID contract |
| Updates thread status to "paused" in DB | Status persistence |
| Does not throw when sidecar is null | Null safety |

### createAndSendMessage Tests

| Test | Validates |
|------|-----------|
| Creates thread and sends first message | Happy path |
| In direct mode, creates thread via ThreadRepo.create (not createThread) | Mode routing |
| In worktree mode, delegates to this.createThread | Mode routing |
| Generates title from first line of content, truncated at 50 chars | Title generation |
| Re-reads thread from DB to pick up model update from sendMessage | DB round-trip |

### deleteThread Tests

| Test | Validates |
|------|-----------|
| Stops running agent via sidecar.stopSession | Agent cleanup |
| Soft-deletes DB record | Delete path |
| With cleanupWorktree=true, calls removeWorktree | Disk cleanup |
| With cleanupWorktree=false, skips removeWorktree | Flag respect |

### shutdown Tests

| Test | Validates |
|------|-----------|
| Stops all active sessions | Session cleanup |
| Marks active threads as "interrupted" in DB | Status persistence |
| Closes database | Resource cleanup |
| Clears activeSessionIds set | Memory cleanup |

### Utility: truncateTitle (internal to app-state)

| Test | Validates |
|------|-----------|
| Short content (<= 50 chars) returned as-is | No-op path |
| Empty content returns "New Thread" | Fallback |
| Long content truncated at word boundary with "..." | Truncation logic |
| Multi-line content uses first line only | Line extraction |

Note: `truncateTitle` is not exported. Test it indirectly via `createAndSendMessage`, or export it for direct testing.

## Priority 4: Worktree & Config Tests

### File: `apps/desktop/src/main/__tests__/worktree.test.ts`

#### validateName (unit, no git needed)

| Test | Validates |
|------|-----------|
| Accepts "my-feature", "fix-123" | Valid names |
| Rejects empty string | Empty guard |
| Rejects >100 chars | Length guard |
| Rejects ".." (path traversal) | Security |
| Rejects names with "/" or "\\" | Path separator injection |
| Rejects dot-prefixed names | Hidden file prevention |

#### Git operations (integration, temporary git repo)

Setup: `beforeAll` creates a temp directory, runs `git init`, creates an initial commit so branches work.

| Test | Validates |
|------|-----------|
| createWorktree creates directory and branch mcode/<name> | Happy path |
| createWorktree throws if repo path doesn't exist | Input validation |
| createWorktree throws if worktree directory already exists | Collision guard |
| removeWorktree cleans up directory and branch | Cleanup |
| removeWorktree returns true even if worktree already gone | Idempotency |
| listBranches sorts: current first, then local > worktree > remote, then alphabetical | Multi-level sort contract |
| listWorktrees returns worktree entries from disk | Directory listing |
| branchExists returns true for existing branch, false otherwise | Branch lookup |
| checkoutBranch switches to the specified branch | Branch switch |
| getCurrentBranch returns branch name | Happy path |
| getCurrentBranch returns "main" on failure | Fallback |

### File: `apps/desktop/src/main/__tests__/config.test.ts`

Mock `fs.existsSync` and `which.sync` via `vi.mock`.

| Test | Validates |
|------|-----------|
| All flags true when user and project config exist | Full config detection |
| All flags false for bare workspace | Empty detection |
| Detects CLAUDE.md at workspace root | Root placement |
| Detects CLAUDE.md inside .claude/ directory | Nested placement |
| Respects MCODE_CLAUDE_PATH env override (save/restore `process.env` in beforeEach/afterEach) | Env config |
| spawnEnv includes HOME key | Env construction |

## Priority 5: SidecarClient Unit Tests

### File: `apps/desktop/src/main/__tests__/sidecar-client.test.ts`

Mock `@anthropic-ai/claude-agent-sdk`'s `query()` to return a controlled async iterable. The mock must return an object that is both an async iterable (for `for await`) and has a `.setModel()` method (no-op or mock). A helper like `createMockQuery(events: Array<{type, ...}>)` should yield events from the array, making tests declarative. Verify the event emission contract.

| Test | Validates |
|------|-----------|
| Assistant message: emits session.message with accumulated text on result | Text accumulation |
| Tool use block: emits session.toolUse with toolCallId, toolName, toolInput | Tool detection |
| Tool result event: emits session.toolResult with output and isError | Result forwarding |
| Result event: emits session.turnComplete with cost and token counts | Turn completion |
| SDK throw: emits session.error then session.ended | Error handling |
| stopSession mid-stream aborts the async generator | Abort mechanism |
| Duplicate session ID aborts previous session first | Dedup safety |
| shutdown aborts all sessions and clears map | Cleanup |
| isReady returns true immediately (no subprocess) | Ready state |

## Priority 6: Frontend Gap Coverage

### File: `apps/web/src/__tests__/settings-store.test.ts`

| Test | Validates |
|------|-----------|
| Default theme is "system" | Initial state |
| Default maxConcurrentAgents is 5 | Initial state |
| setTheme updates state | Setter |
| setMaxConcurrentAgents updates state | Setter |
| setNotificationsEnabled updates state | Setter |

### File: `apps/web/src/__tests__/model-registry.test.ts`

| Test | Validates |
|------|-----------|
| MODEL_PROVIDERS contains Claude with 3 models | Registry data |
| findModelById returns correct model | Lookup |
| findModelById returns undefined for unknown ID | Miss case |
| findProviderForModel returns provider | Reverse lookup |
| findProviderForModel returns undefined for unknown model | Miss case |
| getDefaultModel returns Claude Sonnet 4.6 | Default selection |

### File: `apps/web/src/__tests__/thread-status.test.ts`

| Test | Validates |
|------|-----------|
| isActuallyRunning=true returns "Working" with yellow | Live state priority |
| status "errored" returns "Errored" with red | Error display |
| status "completed" returns "Completed" with green | Completion display |
| Default status returns empty label with muted color | Idle state |

### File: `apps/web/src/__tests__/time.test.ts`

| Test | Validates |
|------|-----------|
| < 1 minute ago returns "now" | Immediate |
| 5 minutes ago returns "5m" | Minutes |
| 3 hours ago returns "3h" | Hours |
| 2 days ago returns "2d" | Days |
| 45 days ago returns "1mo" | Months |
| Future date (negative diff) clamped to "now" | Edge case |

### File: `apps/web/src/__tests__/shortcuts.test.ts`

| Test | Validates |
|------|-----------|
| registerShortcut adds to list, returns unregister fn | Registration |
| Unregister function removes shortcut | Cleanup |
| handleKeyDown fires matching handler and prevents default | Dispatch |
| handleKeyDown respects ctrl/meta modifier | Modifier matching |
| handleKeyDown respects shift modifier | Shift matching |
| No match: handler not called, default not prevented | Miss case |
| getShortcuts returns current list | Read access |

### File: `apps/web/src/__tests__/tool-call-matching.test.ts`

Tests the `session.toolResult` handling in `threadStore.handleAgentEvent`.

| Test | Validates |
|------|-----------|
| Tool result with matching ID completes the correct tool call | ID match |
| Tool result with non-matching ID falls back to last incomplete | Fallback path |
| Multiple concurrent tool calls resolve independently by ID | Concurrent safety |
| All tool calls already complete: fallback does nothing | No-op safety |
| Out-of-order results don't overwrite completed calls | Order independence |

### File: `apps/web/src/__tests__/agent-event-branches.test.ts`

Tests `handleAgentEvent` branches not covered by existing streaming/lifecycle tests.

| Test | Validates |
|------|-----------|
| `bridge.crashed` clears all running threads, sets error | Crash recovery |
| `session.error` clears thread running state, sets error message | Error handling |
| `session.delta` appends text to streamingByThread | Streaming accumulation |
| `session.turnComplete` with streaming content commits message | Turn commit |
| `session.turnComplete` without streaming content clears state only | Clean turn end |
| `session.toolUse` adds tool call to toolCallsByThread | Tool tracking |

## Coverage Targets

| Layer | Current | Target | New Test Files |
|-------|---------|--------|---------------|
| Repos + DB | 0% | ~95% | 1 |
| AppState | 0% | ~85% | 1 |
| Worktree | 0% | ~80% | 1 |
| Config | 0% | ~90% | 1 |
| SidecarClient | 0% | ~85% | 1 |
| Frontend stores | ~60% | ~85% | 2 |
| Frontend utilities | ~30% | ~80% | 5 |
| **Overall** | **~20%** | **80%+** | **12** |

## Coverage Measurement

Both Vitest configs should include `@vitest/coverage-v8`:

```ts
// In vitest.config.ts (both desktop and web)
coverage: {
  provider: "v8",
  reporter: ["text", "json-summary"],
  thresholds: { lines: 80, branches: 75, functions: 80 },
}
```

Run: `bun run test -- --coverage` to verify thresholds. CI should enforce this in the test step.

## What Is NOT Tested

Explicitly out of scope:

- **`apps/desktop/src/main/index.ts`** (Electron lifecycle + IPC registration): Requires a running Electron instance. Test indirectly through AppState.
- **`apps/desktop/src/main/logger.ts`** (Winston config): Configuration-only, no logic to test.
- **`apps/desktop/src/main/models.ts`** and **`sidecar/types.ts`**: Type definitions only.
- **`apps/desktop/src/preload/index.ts`**: contextBridge wiring, requires Electron runtime.
- **UI components** (`ChatView`, `Sidebar`, `MessageBubble`, etc.): Covered by E2E tests, not unit tests.
- **E2E test expansion**: Existing Playwright smoke tests are adequate for now. Expansion deferred to a separate effort.

## Implementation Order

1. Desktop Vitest config + DB helper
2. Repository integration tests
3. AppState integration tests
4. Worktree tests (validateName unit + git integration)
5. Config tests
6. SidecarClient tests
7. Frontend: settings-store, model-registry, thread-status, time, shortcuts
8. Frontend: tool-call-matching tests
9. Run full suite, verify 80%+ coverage
