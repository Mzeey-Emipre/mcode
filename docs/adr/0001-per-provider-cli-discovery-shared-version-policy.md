---
status: accepted
---

# Provider CLI discovery is per-provider; version policy is the one provider-blind seam

## Context

Issue #542 adds an ordered Copilot CLI resolver because the `@github/copilot-sdk`'s
narrow 14-path search misses common installs (npm-global, Windows `.ps1`
ExternalScript shims). While shaping it we asked whether CLI discovery and version
checking should be unified into one resolver shared across every provider (Claude,
Cursor, Codex, OpenCode, Copilot), anticipating a future need for minimum-supported
versions and "please update your provider" prompts.

## Decision

Discovery stays per-provider. Each provider keeps its own mechanism for locating its
CLI and probing its version, and returns a raw version string plus the discovery
source. Discovery makes no min-version judgment.

The only genuinely provider-blind concern is version policy: comparing a detected
version against a per-provider floor and phrasing the update prompt. That logic
already exists as Codex's pure `meetsMinVersion` (`codex-version.ts`). It is promoted
to a shared module only when a second provider needs the update-prompt UX. The shared
policy receives each provider's version and floor; it never holds or discovers them.

## Considered Options

- **Unified cross-provider discovery resolver (rejected).** It would have exactly one
  real adapter today (Copilot is the only provider with a discovery problem; Codex
  resolves via the configured path or PATH), so the seam is hypothetical. It also
  lands discovery in `packages/shared`, where the verify gate forces the full
  unit-test suite on every edit. Discovery churns constantly during development, so
  this makes verification slower, not faster.
- **Per-provider discovery, shared version policy (accepted).** Keeps discovery deep
  and locally testable in `apps/server`, on the scoped `vitest related` path. The
  provider-blind comparator is the real two-adapter seam (Codex today, Copilot next),
  and it carries almost nothing, so its rare presence in a shared package is cheap.

## Consequences

- The Copilot resolver returns `{ entry, version, source }` and stops. It must not
  bake in a floor or a min-version comparison.
- When minimum-supported-version enforcement is wanted for a second provider, extract
  `meetsMinVersion` plus the floors table and update-prompt copy into a small shared
  version-policy module fed by each provider's raw version. Do not merge the discovery
  resolvers.
