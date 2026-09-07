# Plugin Directory and Permission Receipts

**Date:** 2026-07-17
**Status:** Proposal
**Research:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Mcode can discover skills from provider and plugin caches, but users cannot browse available plugin bundles, understand what they add, inspect requested permissions, or install a missing capability without leaving their current task. The words provider, plugin, skill, MCP server, app, hook, and slash command are easy to blur when the UI does not show their ownership and boundaries.

## Product outcome

Add a plugin directory and installed-plugin manager. Each plugin has a manifest-backed detail view that explains its publisher, contents, permissions, data destinations, compatibility, and update history. Installing a plugin creates a local receipt. When a task encounters a missing plugin, Mcode can preserve the draft and resume from the blocked step after the user reviews and installs it.

## Goals

- Browse, search, filter, install, update, disable, and uninstall plugins.
- Show the exact skills, apps, MCP servers, hooks, commands, and browser capabilities contributed by each bundle.
- Explain requested filesystem, network, process, credential, app, and browser permissions before installation.
- Preserve task state while resolving a missing-plugin dependency.
- Keep plugin state and permissions visible by project and user scope.

## Non-goals

- Treating a skill or MCP server as a plugin.
- Auto-installing a capability because an agent requested it.
- Running arbitrary marketplace code before manifest and trust checks.
- Building a public publishing marketplace in the first delivery.

## Directory and detail behavior

The directory separates Available, Installed, Updates, Disabled, and Incompatible. Search covers name, publisher, capability, and contributed component. Filters include source, permission class, provider compatibility, platform, and update status.

A detail view shows:

- signed identity or local source path;
- publisher and source repository;
- current and available versions;
- contributed skills, apps, servers, hooks, commands, and browser extensions;
- permission changes from the installed version;
- configuration and credential requirements;
- compatible Mcode and provider versions;
- install, update, disable, and uninstall effects.

Install and update confirmations group permissions by effect and name any external service receiving data. A changed permission set requires a new confirmation. Disabling stops future activation without removing configuration. Uninstall previews retained settings and identifies task references that will stop working.

## Resume a blocked task

When a user or agent references an available but missing plugin, Mcode opens its detail view beside the intact composer. The install request states which capability caused the block. The prompt, attachments, provider, mode, worktree, and queued messages remain unchanged.

After installation and required connection steps, Mcode returns to the same draft. It does not submit the prompt automatically. If installation fails or the user cancels, the draft remains and the unavailable capability is clearly marked.

## Trust and lifecycle rules

- Manifests and package contents are validated before activation.
- Install sources use an allowlisted protocol and bounded package size.
- Integrity is verified for downloaded versions. A changed artifact under the same version fails closed.
- Hooks, servers, and apps run only with their declared and accepted permissions.
- Credentials use the protected environment or OS credential boundary and never enter plugin manifests, logs, or web payloads.
- Updates never broaden permissions silently.
- Removing a plugin cannot delete project files or external service data.
- The receipt records source, integrity, version, granted permissions, scope, time, and user action.

## Acceptance criteria

1. Users can distinguish plugins from their contributed skills, apps, servers, hooks, and commands.
2. Directory search and filters expose available, installed, disabled, incompatible, and update states.
3. Install and update screens show publisher, source, version, integrity, compatibility, and permissions.
4. New or broadened permissions require explicit confirmation.
5. A missing-plugin flow preserves the entire unsent task and returns to it after installation or cancellation.
6. Mcode never submits the preserved prompt automatically.
7. Disable and uninstall effects are previewed and recoverable where possible.
8. Plugin credentials never reach logs, manifests, provider prompts, or the web process.
9. Corrupt, oversized, incompatible, unsigned when signing is required, or integrity-mismatched packages fail closed.
10. Every lifecycle change produces an inspectable local receipt.

## Verification protocol

- Unit-test manifest validation, compatibility, permission diffs, integrity, and state transitions.
- Integration-test install, disable, update, uninstall, retained configuration, and failed rollback.
- Open a task that references a missing test plugin, install it, and confirm the draft and worktree state survive unchanged.
- Attempt an update with a broadened permission and confirm activation waits for consent.
- Attempt integrity mismatch and oversized-package cases and confirm no code activates.
- Run `bun run verify` after the live checks.

## Repository anchors

- `apps/server/src/services/skill-service.ts`
- `apps/server/src/services/plugin-cache-scanner.ts`
- `apps/server/src/services/protected-env-store.ts`
- `packages/contracts`
- `apps/web/src/components/settings`

## Reference behavior

OpenAI documents plugin bundles, directory installation, management, and contributed skills, apps, MCP servers, hooks, and browser capabilities in [Plugins](https://learn.chatgpt.com/docs/plugins). The missing-plugin continuation behavior is documented in [Desktop app commands](https://learn.chatgpt.com/docs/reference/commands).
