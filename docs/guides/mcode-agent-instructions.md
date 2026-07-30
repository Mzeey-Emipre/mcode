# Mcode runtime agent instructions

Mcode derives a short runtime instruction plan from capabilities proven during
provider session setup. Identity guidance is always present. Thread-control
guidance appears only after the internal `mcode_internal_thread_control` MCP
connection is established. Browser guidance appears only after a Browser lease
is issued for that session. MCP authorization and lease state remain
authoritative; instruction text does not grant permissions.

The package `@mcode/thread-orchestration` owns capability semantics and canonical
copy. Provider adapters render that plan through native fields:

- Codex passes it as `developerInstructions` on `thread/start` and
  `thread/resume`.
- Claude appends it to the Claude Code `systemPrompt` preset.
- Copilot appends it to existing user instructions in `systemMessage` for
  create and resume.
- Cursor retains it per logical ACP session and adds it to the first normal
  prompt only. Cursor has no ACP session-level instruction field, so static
  repository instructions are not modified.

Output is capped at 4000 characters with an explicit truncation marker. Copy
contains server and tool names, routing constraints, and no credentials, URLs,
or filesystem paths.

When an agent needs a named provider or model, runtime guidance routes it through
`thread_target_list`; the exact returned `providerId` and `modelId` must then be
passed to `thread_create_batch`. The guidance does not enumerate or guarantee a
static provider list.
