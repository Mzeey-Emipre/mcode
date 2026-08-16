# Database Migrations

Migrations are managed by [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview).
The declarative schema lives in `apps/server/src/runtime/persistence/sqlite/schema.ts`. Generated SQL
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
