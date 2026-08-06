# Database Migrations

Migrations are managed by [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview).
The declarative schema lives in `apps/server/src/store/schema.ts`. Generated SQL
files live under `apps/server/drizzle/`.

```sh
cd apps/server

bun run db:generate    # Emit SQL from schema edits (review before commit)
bun run db:migrate     # Apply pending migrations via drizzle-kit (needs DB URL config for CLI)
bun run db:push        # Push schema directly (dev only; can be destructive)
bun run db:studio      # Drizzle Studio (visual browser)
```

App startup runs Drizzle `migrate()` programmatically against the user's SQLite file,
including legacy `_migrations` detection (`bootstrapDrizzle`) so existing installs
upgrade without manual steps.

## Frozen Terminal v1 migration seams

The Terminal v1 persistence contract is forward-only. This section describes
the migration boundary; it does not add SQL or claim that the current runtime
has applied it.

### `workspace_terminal_preferences`

The migration adds one workspace preference row keyed by `workspaceId`. A row
stores only:

- `workspaceId`: the owning workspace ID.
- `defaultProfileId`: `automatic`, a certified profile ID, or a custom profile
  ID. Explicit `automatic` selects automatic resolution; it does not mean
  inheritance.
- `updatedAt`: the last atomic update timestamp.

There is at most one row per workspace. Missing rows mean inherit. Updating a
workspace preference upserts the row; reset deletes it. Workspace deletion
closes all Terminal sessions before deleting the preference row. Existing
sessions keep their immutable launch snapshots, so this preference affects
future creates only.

### `terminal_cleanup_ledger`

The cleanup-ledger migration records only the process identity required for
safe reaping: logical `sessionId`, `hostGeneration`, root PID, process-group
identity, containment mechanism, and bounded lifecycle timestamps. Native
handles, working directories, environment values, profile arguments, and
renderer data are never persisted.

The ledger is bounded to 20 records. Records are created when a host reports a
running session, checked against both session identity and host generation
before reaping, and removed after confirmed close. Startup reaping handles
leftover roots from a prior boot. Scope close and app shutdown run the same
identity checks, then reap and delete records; a failed reap remains bounded
and visible for the next startup attempt. The migration must not leak native
handles or permit a stale generation to kill a replacement process.

Migration tests must cover forward-only application, idempotence, malformed
rows, workspace reset and deletion, startup reaping, generation checks, the
20-record bound, and no native-handle leakage.

## Branch-specific databases (development)

In a linked git worktree (where `.git` is a file pointing at the common git dir),
dev mode uses `<toplevel>/.mcode-local/mcode.db` inside that checkout so schemas
stay with the worktree.

When developing in the primary repo directory (`main` checkout with `.git/` as a
directory), `NODE_ENV` is not `production` and `MCODE_GIT_BRANCH` is set (or
detected via `git rev-parse`), the DB file is `<mcodeDir>/dbs/dev-<hash>.db`
instead of `<mcodeDir>/mcode.db`. Production stays on `~/.mcode/mcode.db`.

## Known limitation: FK pragmas inside transactions

Drizzle's `migrate()` wraps each migration in a transaction. SQLite ignores
`PRAGMA foreign_keys` inside transactions, so Drizzle Kit's generated
`PRAGMA foreign_keys=OFF` statements are silently no-ops. This is harmless for
tables with no inbound FK references (the current state). If a future migration
needs to rebuild a table that other tables reference via FK, the SQL must be
split into a separate non-transactional step or applied manually outside
`migrate()`.
