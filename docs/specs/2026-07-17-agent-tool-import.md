# Agent Tool Import

**Date:** 2026-07-17
**Status:** Proposal
**Research:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Developers who adopt Mcode already have projects, instruction files, skills, MCP servers, hooks, commands, provider settings, and agent definitions in other tools. Recreating them by hand is slow and encourages incomplete migration. A direct copy is also unsafe because different products use different trust, scope, secret, and execution models.

## Product outcome

Add a read-only import assistant for Codex, Claude, Cursor, Copilot, and OpenCode configuration. The assistant discovers supported sources, previews a provider-neutral mapping, identifies conflicts and unsupported fields, and applies only the user's selected items. Source files remain untouched and each import produces a reversible receipt.

## Goals

- Detect supported tool configuration at user and project scope.
- Import projects, instruction references, settings, skills, plugin references, MCP servers, hooks, slash commands, and sub-agent definitions where a safe mapping exists.
- Preview destination, scope, conflicts, permission changes, and unsupported fields before writing.
- Preserve source files and existing Mcode configuration.
- Support project-by-project selection and reversible imports.

## Non-goals

- Importing authentication tokens, browser sessions, account data, or secret values.
- Claiming semantic equivalence where Mcode lacks a matching concept.
- Deleting or rewriting the source tool's configuration.
- Automatically enabling imported executable hooks, servers, or plugins.
- Importing private chat transcripts in the first delivery.

## Discovery and preview

Import starts with a bounded read-only scan of known configuration locations or a user-selected directory. The results group items by source tool and scope. Every detected item records its source path, format, last modification time, and parser status.

The preview classifies each mapping as:

- **Ready:** lossless within the supported Mcode contract.
- **Needs choice:** conflicts with an existing name, scope, or destination.
- **Review permissions:** introduces executable code, network access, filesystem access, or an external service.
- **Partial:** supported fields can import, while named fields cannot.
- **Unsupported:** no safe Mcode representation exists.

Users can inspect a normalized diff for each item. Partial mappings default off. Unsupported content can be copied as a reference attachment, but cannot masquerade as active configuration.

## Application and receipt

The apply screen summarizes selected writes by project and user scope. Mcode validates all source paths again, confirms they still match the previewed content hash, and writes through the destination's normal validation path. Existing items are never overwritten without an item-level choice.

The receipt records source tool, source hashes, selected mappings, created destination identities, skipped fields, conflicts, permission decisions, time, and Mcode version. Undo removes only items created by that receipt and only when they have not been edited or adopted elsewhere. Otherwise, Mcode shows a reviewable cleanup plan.

## Mapping rules

- Project folders become Mcode projects only after canonical-path and repository validation.
- Instruction files remain references to their repository locations when possible.
- Skills import through the normal skill validation and conflict rules.
- Plugin references resolve through the plugin directory and do not install automatically.
- MCP servers import without credentials and remain disabled until configuration and permissions are reviewed.
- Hooks and commands remain disabled until their executable target, arguments, environment needs, and scope pass validation.
- Sub-agent definitions map provider, model, instructions, and tools only when each field has a supported equivalent.
- Unknown settings stay in the receipt as unsupported evidence.

## Security and privacy

- Discovery never executes source code, resolves remote includes, starts servers, or follows symlinks outside approved roots.
- Parsers enforce file count, size, nesting, string, and collection bounds.
- Secret-shaped values are excluded and named as required manual setup without echoing their contents.
- Executable imports default disabled and require the destination's normal permission flow.
- Source paths, configuration text, and import receipts stay local.
- A malicious source name, path, command, or description cannot escape its destination scope or become shell input.

## Acceptance criteria

1. The assistant detects supported user and project configuration without modifying or executing source content.
2. Every item has a source, destination, scope, mapping status, content hash, and selected state.
3. Conflicts and partial mappings require an item-level choice.
4. Unsupported fields remain visible in the receipt and are never silently discarded.
5. Secrets and authentication state are not imported, displayed, logged, or stored in receipts.
6. Plugins, MCP servers, hooks, commands, and other executable capabilities do not activate automatically.
7. Source changes between preview and apply stop the affected item and request a refresh.
8. Existing Mcode configuration is preserved unless the user explicitly resolves a conflict.
9. Undo removes only unchanged items created by the selected receipt.
10. Repeating the same import is idempotent and reports already-imported items.

## Verification protocol

- Unit-test each supported parser, bounds, path containment, mapping status, conflict behavior, and secret exclusion.
- Use fixture configurations from every supported source tool, including malformed, oversized, cyclic, and hostile examples.
- Preview a mixed user and project import, select a subset, apply it, and inspect the receipt.
- Change one source after preview and confirm only that item stops before write.
- Undo the receipt, then edit one imported item and confirm cleanup does not remove the edited item.
- Verify source directories and files remain byte-for-byte unchanged.
- Run `bun run verify` after the live checks.

## Repository anchors

- `apps/server/src/services/skill-service.ts`
- `apps/server/src/services/plugin-cache-scanner.ts`
- `apps/server/src/services/settings-service.ts`
- `packages/contracts`
- `apps/web/src/components/settings`

## Reference behavior

OpenAI documents non-destructive import of projects, recent chats, instructions, settings, skills, plugins, MCP servers, hooks, commands, and sub-agent definitions in [Import](https://learn.chatgpt.com/docs/import). Mcode's provider-neutral mapping and reversible receipt can make migration more transparent than a one-way copy.
