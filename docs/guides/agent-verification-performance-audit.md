# Agent verification performance audit

This audit measured targeted checks on 2026-09-06 in the Windows worktree. The installed runtimes were Bun 1.4.0 and Node 26.5.0. These results measure this repository only and do not attribute a speedup to a runtime implementation change.

The reproducible web harness and its raw stdout and stderr receipts remain local under `.dev/verification/performance/` and are not reviewable from this branch. The retained [measurement summary](agent-verification-performance-2026-09-06.json) is committed for review.

## Equal-workload runtime comparison

From `apps/web`, the harness ran the same three behavior tests under direct Vitest invocation: a Badge component, `AppErrorBoundary`, and the navigation history store. It ran one excluded warmup, then three retained samples for each runtime. Each completed sample selected 3 files and passed 10 tests. The receipt records the child command, cwd, runtime identity, timestamps, wall time, exit status, and full output.

| Runtime | Warmup wall time | Retained wall time, ms, min / median / max |
| --- | ---: | ---: |
| Bun 1.4.0 | 3,988 | 3,383 / 4,267 / 4,846 |
| Node 26.5.0 | 7,232 | 6,169 / 7,235 / 9,366 |

This comparison is limited to local Node 26, not CI's Node 22. It establishes that the installed Bun can run this representative Vitest workload; it does not justify a production runtime or Electron ABI change. An unchanged store test that imports contracts failed under Bun with `z.enum` undefined, so it was not used for the timing comparison. The local paired receipt records Bun exit 1 and the `z.enum` diagnostic, while Node exit 0 for the same command. It needs separate investigation before expanding Bun-based web proof.

The initial one-file web samples mixed cold and warm runs (4,049 to 17,510 ms), so they cannot identify jsdom, React Compiler, Tailwind, or another plugin as the cause. The shared Vite configuration remains unchanged. Switching its environment or plugin set would affect 380 web tests, of which only two explicitly request Node.

## Selector and verifier scope

`scripts/agent/test-scripts.mjs` previously ignored positional arguments. A command naming `root-dev-script.test.mjs` began the whole maintained collection and did not complete within 30.4 seconds, reaching an unrelated fixture test. That is a selection bug, not a comparable timing baseline. The selector now accepts only existing regular `.test.mjs` files directly inside its maintained directory. Omitted arguments still select the full maintained collection.

Three completed named-file runs after the fix took 731, 786, and 880 ms. The fix is verified by a focused test that rejects nested paths, a sibling file, a directory with a test-looking name, and a symlink where Windows allows it.

The runtime verifier now runs its contract proof through the contracts workspace's Vitest script. Runtime and thread-lifecycle checks no longer append repository-wide lint. They retain their named behavior-specific workspace tests. The verifier skill now directs selection to the canonical focused-check workflow and keeps live proof for the applicable boundary.

## Cache correctness without serial tests

`turbo.json` had no dependency edge for `test` or `typecheck`. A tracked, isolated two-package fixture reproduced the risk: changing upstream source left the consumer test hash unchanged at `973e8d1ccd1dd20b`. A transit node made the consumer hash change from `c697d0f5c01d25d4` to `7a0146ec2910fc02` after the same upstream edit. The supporting dry-run receipts remain local and are summarized in the committed measurement data.

The `transit` task follows dependency edges but runs no package command. Both `test` and `typecheck` depend on their local transit node, so consumer checks invalidate after dependency source changes while the actual test and typecheck tasks remain parallel. An unrelated package is absent from the selected consumer dry-run graph.

## Selecting real blast radius

Use the focused workflow in [agent-workflow.md](agent-workflow.md#focused-checks). The dependency graph tool resolves relative imports only and caches by `HEAD`; it misses `@/` aliases, `@mcode/*` exports, and uncommitted edits. Refresh the candidate after editing, then inspect direct callers and map transport, event, DI, and contract consumers manually. Broad coverage is sometimes justified: `threadStore` has 37 non-test direct alias importers and itself connects several stores, transport, residency, and hydration.

## Launcher attribution limits

Earlier targeted samples retained wall time and Vitest's own duration. Their difference is unreported process and launcher work, not a measured shell-only cost. The server command must keep its Electron-backed launcher because of the SQLite ABI. This audit did not replace it or measure an ABI-compatible direct spawn alternative.
## Scope limits

No historical failing UI example was supplied, so this audit does not classify prior failures as regressions or coupling. The Node comparison uses Node 26 rather than CI Node 22, and local timings include ordinary host scheduling variation. No whole-workflow speed claim follows from these selected commands. The graph-tool limitation is external to this repository and was not changed.

## Additional cache-input proof

A tracked isolated fixture exercised the root-helper inputs and desktop-to-server edge. Changing its root test helper changed the selected consumer hash from `33bc1db7929c56f1` to `318ae8d91d02118f`. Changing server source changed the selected desktop hash from `fbe73b4dff378a5e` to `becaac98fd575a49`. Changing an unrelated package left the consumer hash unchanged at `33bc1db7929c56f1`. The complete local receipt is not committed; the committed measurement data retains these hashes.

The scoped lint command was `bun run --cwd packages/oxlint-plugin build; .\node_modules\.bin\oxlint.exe scripts/agent/test-scripts.mjs scripts/agent/__tests__/root-dev-script.test.mjs .agents/skills/verify-mcode/scripts/runtime.mjs .agents/skills/verify-mcode/scripts/runtime.test.mjs .agents/skills/verify-mcode/scripts/thread-lifecycle.mjs .agents/skills/verify-mcode/scripts/thread-lifecycle.test.mjs`. It exited 0 with no oxlint findings.

## Focused verification

The final focused checks ran against this working tree: `bun run test:scripts -- scripts/agent/__tests__/root-dev-script.test.mjs` passed 7 tests; `node --test .agents/skills/verify-mcode/scripts/runtime.test.mjs` passed 6 tests; `bun test scripts/thread-lifecycle.test.mjs` from the verifier directory passed 7 tests with 1 platform skip; and `bun run --cwd packages/contracts test -- src/__tests__/subagent-presentation.test.ts` passed 7 tests. The timing baseline source revision was `039d926ac63abedbbcc14e698c80b661430d8e67`.

The web harness runs all Bun samples before all Node samples. Its results therefore compare equal commands and retained warm samples, but do not randomize host ordering. Raw child output and before-and-after cache dry-run files remain local and are not part of this review.

The `../../scripts/...` task inputs are package-relative. Every affected workspace is two directories below the repository root, so one scoped pattern covers packages and apps. This keeps root helper invalidation on `test` tasks instead of using a repository-wide dependency declaration. `build-server-dev-bundle.mjs` is desktop-only, so it is listed only for `mcode-desktop#test`. `$TURBO_ROOT$` could also express root paths, but it would not make this configuration narrower.
