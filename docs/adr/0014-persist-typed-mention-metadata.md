# Persist typed @ mention metadata beside message text

Mcode uses `@` for a shared composer mention picker whose results can be files, provider sub-agents, and later other reference types. We will persist each selected mention as typed metadata beside the readable message text, with enough identity and range data to render the composer transcript and serialize provider-specific payloads without reparsing raw `@...` strings.

For Codex, typed file and sub-agent mentions serialize to native app-server `mention` input parts with `name` and `path`; Mcode does not inline file contents or agent instructions for selected mentions when the provider can resolve them. Codex mention suggestions should come from the app-server where it exposes the needed catalog or search API, such as `fuzzyFileSearch` for files. Providers without native mention support keep the existing fallback behavior, such as file-content injection.

`/` commands and `@` mentions should share one grouped suggestion UI primitive with separate data sources and section labels. This keeps keyboard behavior, loading states, and provider-scoped grouping consistent while preserving the different semantics of commands and mentions. Codex may expose the same underlying entry through both surfaces: `/` invokes or expands it as a command or skill, while `@` inserts it as a typed mention for provider-native resolution.

## Considered Options

Parsing message text on demand would avoid schema work, but it would make file paths, provider agent names, and future mention targets compete for the same plain-text pattern. Typed metadata adds storage and migration work, but keeps transcript rendering and provider serialization deterministic after reload.
