# Node runtime and native-module strategy

Research date: 2026-07-25
Scope: explain [Nightly Desktop run 30149874833](https://github.com/Mzeey-Empire/mcode/actions/runs/30149874833), identify why the local Node pin broke some CI runners, and recommend one permanent runtime policy for local development, verification, and packaging.

## Executive summary

The pin itself is not the mistake. The repository needs one declared Node runtime because `better-sqlite3` is a native addon and its Node binary is ABI-specific. The incomplete part of the fix is that only `.github/workflows/ci.yml` installs the declared runtime. The nightly, release, and desktop dry-run workflows still inherit whatever `node` happens to be on each runner.

Run 30149874833 demonstrates that split:

- Ubuntu inherited Node 20.20.0 and completed.
- Windows inherited Node 22.19.0, while both macOS jobs inherited Node 24.16.0. The root `preinstall` check expected Node 20.20.0, exited with status 1, and prevented dependency installation.
- Retrying the same deterministic version mismatch could not recover.

The permanent fix is to move the repository pin to a supported Node 24 patch release, retain `.node-version` as the single source of truth, and run `actions/setup-node` from that file before `setup-bun` or `bun install` in every workflow. Node 20 reached end of life on 2026-03-24 and no longer receives security fixes, so making CI install Node 20 would repair this run but preserve an obsolete runtime. Node 24 is supported by the locked `better-sqlite3` 12.9.0 release, which publishes Node ABI 137 prebuilds for the repository's Windows, macOS, and Linux targets.

## Failure evidence

The [workflow run](https://github.com/Mzeey-Empire/mcode/actions/runs/30149874833) checked out commit `ba51ebd07c060283fa1ded4aaf595beb76d05ab7`. Three jobs failed in `Install dependencies`:

| Job | Inherited Node | Result |
| --- | --- | --- |
| [macOS arm64](https://github.com/Mzeey-Empire/mcode/actions/runs/30149874833/job/89658323597) | 24.16.0 | `Expected: v20.20.0`, `Actual: v24.16.0`; root preinstall exited 1 |
| [Windows x64](https://github.com/Mzeey-Empire/mcode/actions/runs/30149874833/job/89658323604) | 22.19.0 | Same deterministic mismatch |
| [macOS x64](https://github.com/Mzeey-Empire/mcode/actions/runs/30149874833/job/89658323605) | 24.16.0 | Same deterministic mismatch |
| [Ubuntu x64](https://github.com/Mzeey-Empire/mcode/actions/runs/30149874833/job/89658323618) | 20.20.0 | Install, package, smoke test, and artifact verification succeeded |

The macOS log also records that the runner now uses Node 24 by default. GitHub's runner transition notice says actions are being moved from Node 20 to Node 24, reinforcing why workflows must not depend on the runner's ambient `PATH` ([GitHub changelog](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)).

Before this change, the repository behavior was internally consistent:

- [`.node-version`](../../.node-version) declared `20.20.0`.
- [`package.json`](../../package.json) repeated that exact value in `engines.node` and invoked `scripts/node-runtime.mjs` in `preinstall`.
- [`scripts/node-runtime.mjs`](../../scripts/node-runtime.mjs) intentionally rejects every other patch version.
- [CI](../../.github/workflows/ci.yml) used `actions/setup-node` with `node-version-file: ".node-version"`.
- [Nightly Desktop](../../.github/workflows/nightly-desktop.yml), [Build Release](../../.github/workflows/build-release.yml), and [Desktop Package Dry Run](../../.github/workflows/desktop-package-dry-run.yml) set up Bun but did not set up the repository's Node version before `bun install`.

This is configuration drift, not a flaky native-addon download and not a platform-specific source failure.

## Why the local issue existed

`better-sqlite3` ships a compiled `.node` addon. Node assigns an ABI number to the native-module interface. A binary built for one ABI cannot be loaded by a runtime expecting another ABI. Electron also has its own ABI and requires native modules to be rebuilt or supplied specifically for its target ([Electron native modules guide](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/)).

Mcode deliberately maintains two binaries:

1. `better_sqlite3.node` for repository tests and server tooling under Node.
2. `better_sqlite3.electron.node` for Electron 35.7.5.

That separation is sound. The earlier local failures came from allowing different Node majors to install or execute the Node-side binary. An exact runtime declaration prevents a stale ABI-specific install from appearing healthy until a later test command.

The long-term runtime should not remain Node 20, however. Node's official EOL page records Node 20 as end of life on 2026-03-24 and states that EOL lines receive no further security fixes ([Node.js EOL policy](https://nodejs.org/en/about/eol)). The `better-sqlite3` project requires a currently supported Node version and publishes prebuilt binaries for LTS versions ([better-sqlite3 README](https://github.com/WiseLibs/better-sqlite3#installation)). Its v12.9.0 release assets include Node ABI 137 builds for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`, matching Node 24 and Mcode's current targets ([v12.9.0 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.9.0)).

## Options

### 1. Add Node 20 setup to missing workflows

This is the smallest immediate repair. Add `actions/setup-node` with `.node-version` before dependency installation in Nightly Desktop, Build Release, and Desktop Package Dry Run.

It is not the permanent answer. Node 20 is already EOL, and better-sqlite3 12.10.0 has removed Node 20 prebuilds while retaining supported releases ([v12.10.0 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.10.0)). Remaining on Node 20 increases security and dependency-upgrade risk.

### 2. Remove the exact runtime check

This would let the failing jobs install under their ambient Node 24, but it restores the original local failure mode. Different machines and workflow images could again produce or consume different native ABIs. GitHub's setup-node documentation explicitly recommends specifying Node rather than relying on the system version ([actions/setup-node](https://github.com/actions/setup-node#basic)).

Reject this option.

### 3. Pin supported Node 24 everywhere

This keeps deterministic local and CI behavior, leaves the Electron binary managed separately, and aligns with the prebuilds already published for the locked `better-sqlite3` version.

This is the recommended option.

## Recommended permanent fix

Use one exact, currently supported Node 24 patch release across every environment:

1. Change `.node-version` to Node 24.18.0.
2. Change `package.json#engines.node` to the same exact value.
3. Keep `scripts/node-runtime.mjs` and its entry-point guards. They turn ABI drift into an immediate, actionable failure.
4. Add `actions/setup-node` with `node-version-file: ".node-version"` to every workflow that installs dependencies or runs repository Node scripts. Place it after checkout and before `bun install` or any repository Node command.
5. Keep `scripts/postinstall.mjs` responsible for installing and validating distinct Node and Electron `better-sqlite3` binaries.
6. Keep the lockfile authoritative. Do not rely on a floating `^12.0.0` resolution to gain Node 24 support on a fresh install. The current lock resolves 12.9.0, whose release assets cover Node 24 ABI 137. A later dependency update can move to 12.10.x after its own packaging checks.
7. Update the Bun cache key to include `.node-version`, not only `bun.lock`. Native install output depends on Node ABI, so a Node upgrade must not restore an ABI-ambiguous install cache.

An exact patch pin is appropriate here because native-addon installation is part of the repository's bootstrap. Renovate or Dependabot can propose Node 24 patch updates as explicit, tested changes rather than allowing runner-image drift to change the ABI environment.

## Migration sequence

1. Select Node 24.18.0 from the official [Node 24 archive](https://nodejs.org/en/download/archive/v24).
2. Update `.node-version`, `engines.node`, runtime-check tests, and any documentation that names Node 20.
3. Add the shared setup-node step to Nightly Desktop, Build Release, and Desktop Package Dry Run. Audit all workflows with `rg "bun install|node " .github/workflows` and require setup-node before each matching execution path.
4. Include both `bun.lock` and `.node-version` in Bun install-cache identity.
5. Delete and reinstall local `node_modules` under the selected Node 24 runtime so no Node 20 binary survives the transition.
6. Confirm postinstall reports a Node ABI 137 binary and the separate Electron ABI binary.

## Required gates

- Local bootstrap on Windows from a clean dependency install under the pinned Node 24 patch.
- `bun run doctor`, including both the Node and Electron `better-sqlite3` checks.
- `bun run test:scripts` for runtime-pin and verification-entry behavior.
- Focused tests, typecheck, and lint.
- Worktree-local `bun run --shell system agent:up`, health check, and `agent:down`.
- Desktop Package Dry Run on Windows, macOS arm64, macOS x64, and Linux.
- Nightly Desktop packaging and packaged-server smoke tests on the same matrix.
- A negative workflow test or script test proving a non-pinned Node version fails before installation.

## Decision

Preserve the pinning mechanism, upgrade the pin from EOL Node 20 to supported Node 24, and make every workflow install that declared runtime. This resolves both sides of the problem: local native-module ABI drift stays blocked, while CI no longer depends on an operating-system image's ambient Node version.
