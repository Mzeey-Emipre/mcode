# SQLite performance profile

Run all five database workloads with 20 samples per workload:

```sh
bun run perf:database --output .dev/verification/sqlite-baseline.json
```

The command uses Electron's Node runtime and the repository-managed
`better-sqlite3` binding. It creates isolated, deterministic databases for
startup and migrations, active-turn writes, 100-message reads, 1,000-message
reads, and cleanup. The report includes duration distributions, returned bytes,
process-memory observations, query plans, and active pragma values.

The active-turn workload uses the production repositories and canonical event
sink. Each sample records its committed batch count, bounded row count, and
bounded bytes. This keeps retained-statement and batching measurements on the
same path that persists a running turn.

The report also records the finite active-turn statement set and these write
batch limits:

- 64 rows
- 262,144 bytes
- 4 milliseconds of observed transaction time

The elapsed-time limit is cooperative. The writer checks it after each bounded
write unit, commits the current transaction, and then yields before the next
transaction. No asynchronous work occurs while a transaction is open.

Compare a candidate report with the baseline:

```sh
bun run perf:database --baseline .dev/verification/sqlite-baseline.json --output .dev/verification/sqlite-candidate.json
```

The command exits with code 1 when a candidate median exceeds its baseline by
more than 5 percent. Runtime differences remain in the report as warnings.
Use `--threshold-percent` only when the issue or experiment defines another
limit. Use `--samples` to select from 3 through 50 samples per workload.

## Release certification

Use an approved report from the same profile schema, runtime, and computer:

```sh
bun run certify:database --baseline .dev/verification/sqlite-approved-baseline.json --output .dev/verification/sqlite-certification.json
```

The command fails if the runtime changed or a workload regressed by more than
5 percent. It also fails if a workload omits duration, returned bytes, memory,
query plans, or the required pragma values.

The certification also applies the production lifecycle cache policy and
records the observed `cache_size` pragma after both transitions: 500 KiB while
backgrounded and 2,048 KiB when active.

The same Electron process runs three recovery checks. It forces a migration
failure and checks the restored database bytes. It rejects a backup with no
available disk space before mutation. It also runs seven upgrades and checks
that five generations remain and the public text identifier is unchanged.
