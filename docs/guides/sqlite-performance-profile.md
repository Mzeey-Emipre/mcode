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

Compare a candidate report with the baseline:

```sh
bun run perf:database --baseline .dev/verification/sqlite-baseline.json --output .dev/verification/sqlite-candidate.json
```

The command exits with code 1 when a candidate median exceeds its baseline by
more than 5 percent. Runtime differences remain in the report as warnings.
Use `--threshold-percent` only when the issue or experiment defines another
limit. Use `--samples` to select from 3 through 50 samples per workload.
