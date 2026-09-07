# Provider Memory Capabilities

**Research date:** 2026-07-17

## Scope

This note compares persistent context in Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Cursor Agent, and OpenCode. It separates four mechanisms:

- **Learned memory:** the provider derives reusable facts or preferences from prior work.
- **Persistent instructions:** a person maintains files such as `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`.
- **Session history:** a provider resumes or forks an existing conversation.
- **Mcode memory:** context owned by Mcode and passed across provider boundaries.

The sources expose no common memory API or shared data model. Mcode should therefore treat native memory as a provider capability, not as a portable record.

## Capability matrix

| Provider | Learned memory | Persistent instructions | User review and removal | Documented integration surface |
| --- | --- | --- | --- | --- |
| Claude Code | Auto memory, enabled by default in supported versions | `CLAUDE.md`, `CLAUDE.local.md`, and `.claude/rules/` | Plain Markdown; `/memory` opens files and toggles auto memory | Settings, environment variables, CLI, and local files; no structured memory API is documented |
| Codex | Two-stage extraction and consolidation from eligible rollouts | `AGENTS.md` hierarchy | Local artifacts can be inspected; app-server can disable memory per thread or reset all memory | Experimental app-server methods plus config and local files; no per-memory CRUD API is documented |
| Gemini CLI | Explicit `save_memory` plus experimental Auto Memory | `GEMINI.md` hierarchy, configurable filenames | Auto Memory holds patches and skill drafts in an inbox until approval | Local files, settings, slash commands, and tools; Auto Memory support must be verified for the hosting surface |
| GitHub Copilot | Repository facts and user preferences | Copilot instruction files and `AGENTS.md` support vary by surface | GitHub settings list and delete entries; administrators can export or delete preferences | Provider-managed service and settings UI; no memory CRUD API for Copilot CLI or SDK is documented |
| Cursor | Project-scoped memories generated from chat | `.cursor/rules`, `AGENTS.md`, and `CLAUDE.md` in Cursor CLI | Background memories require approval and are managed in Cursor Settings | Cursor Settings for memories; Cursor CLI documents rules and session resume, but no memory API or CLI command |
| OpenCode | No learned-memory feature found in current official documentation | Project and global `AGENTS.md`, optional instruction paths, and `CLAUDE.md` fallbacks | Files are edited through normal source control or filesystem workflows | Config files, CLI session commands, HTTP server, and SDK session methods; no memory endpoint is documented |

## Claude Code

Claude Code distinguishes user-authored instructions from agent-authored auto memory. `CLAUDE.md` files carry instructions into every session, while auto memory stores patterns derived from corrections and work. Auto memory requires Claude Code 2.1.59 or later and is enabled by default. `/memory`, `autoMemoryEnabled`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` control it. [`--bare` skips instruction discovery and auto memory](https://code.claude.com/docs/en/cli-reference).

Auto memory is machine-local under `~/.claude/projects/<project>/memory/`; worktrees of one repository share a directory. The first 200 lines or 25 KB of `MEMORY.md` load at conversation start, and topic files load on demand. Users can inspect, edit, or delete these files. Anthropic does not document source citations, expiry, branch validation, candidate approval, or an external memory API. [Claude Code memory documentation](https://code.claude.com/docs/en/memory)

Mcode can report whether auto memory is enabled and link to its folder, but should not rewrite Claude's notes without explicit user action. `CLAUDE.md` and resumed history must remain separate context sources.

## Codex

Codex runs a local, two-stage pipeline for eligible root sessions. Phase 1 extracts memories from recent idle rollouts, redacts secrets, and writes to the local state database. Phase 2 selects a bounded set using age, use, and retention settings, then consolidates artifacts under `~/.codex/memories`. A git baseline records changes between consolidations. [Codex memory pipeline](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)

Codex exposes experimental app-server controls. `thread/memoryMode/set` changes a thread's future eligibility. `memory/reset` clears artifacts and memory-stage rows while preserving thread eligibility. Memory citations contain file paths, line ranges, notes, and contributing thread IDs. There is no individual-memory CRUD or approval operation. [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) and [memory citation schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/MemoryCitation.ts)

`memories.generate_memories` controls contribution, while `memories.use_memories` controls injection. Other settings bound rollout age, idle time, startup work, retained inputs, and unused-memory age. These controls need version gating. [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)

Mcode can show thread eligibility, surface native citations, and offer a clearly destructive global reset. Per-item review needs a future Codex contract.

## Gemini CLI

Gemini CLI has three persistent-context layers. Hierarchical `GEMINI.md` instructions load from user, workspace, and just-in-time directory scopes. `save_memory` persists a requested fact to Markdown. `/memory show` displays combined context and `/memory reload` rescans it. File names can include `AGENTS.md`. [Gemini context files](https://geminicli.com/docs/cli/gemini-md/) and [memory files](https://geminicli.com/docs/tools/memory/)

Experimental Auto Memory is off by default. It scans eligible local transcripts, then places memory patches or skill drafts in a project inbox without editing active memory. `/memory inbox` supports inspection, application, promotion, dismissal, and deletion. Selected transcript content may reach the configured model during extraction. No post-approval staleness validation is documented. [Gemini Auto Memory](https://geminicli.com/docs/cli/auto-memory/)

The hosting surface matters. An official-repository issue records that Auto Memory was not started for ACP sessions even when enabled. Mcode must test its exact adapter rather than assume TUI parity. [Gemini CLI issue 25624](https://github.com/google-gemini/gemini-cli/issues/25624)

Mcode can display active instruction files and link to the inbox when available. It should not apply candidates automatically.

## GitHub Copilot

Copilot Memory is a provider-managed public preview. It learns repository facts and user preferences from user-initiated activity. Repository facts carry code citations and are revalidated against the current branch. Preferences remain tied to the user and billing entity. Unused entries are deleted after 28 days, with reset on successful validation and use. Copilot CLI applies both types. [About Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)

GitHub settings let users enable the feature and inspect or delete entries. Administrators have additional deletion and export controls. No documented CLI flag, SDK method, or public API manages individual memories for a session. [Managing Copilot Memory](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/manage-for-yourself)

Copilot CLI reads repository, path-specific, agent, and personal instructions separately; `--no-custom-instructions` skips them. [Copilot CLI customization](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features)

Mcode should present Copilot memory as opaque and provider-managed, without scraping GitHub settings or claiming unavailable citations.

## Cursor

Cursor describes memories as project-scoped rules generated from chat. A sidecar model can propose memories in the background, and those proposals require approval before saving. The agent can also create a memory through a tool call when the user asks it to remember something or when it identifies useful context. Users manage saved memories in Cursor Settings under Rules. The documentation does not publish the storage location, expiry policy, provenance schema, or external API. [Cursor Memories](https://docs.cursor.com/en/context/memories)

Cursor CLI documents a separate rules system. It loads `.cursor/rules` and root `AGENTS.md` or `CLAUDE.md`, and it can resume a prior thread with `--resume`. Its command and parameter references do not document memory inspection, approval, or suppression. [Cursor CLI usage](https://docs.cursor.com/en/cli/using) and [Cursor CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)

Mcode should not assume IDE memories are present in Cursor CLI sessions. Until Cursor publishes a CLI contract, Mcode can expose instruction files and resumed-session status, while labelling native memories as unavailable or externally managed.

## OpenCode

OpenCode's current documentation describes persistent instructions, not learned memory. Project `AGENTS.md` files are intended for source control; `~/.config/opencode/AGENTS.md` supplies personal global rules. OpenCode can fall back to project and global `CLAUDE.md`, and `opencode.json` can add local globs or remote instruction URLs. The first matching project and global rule files win, while configured instruction files are combined with them. [OpenCode rules](https://opencode.ai/docs/rules/)

OpenCode persists sessions separately. CLI flags continue or fork sessions, `opencode session list` enumerates them, and exports produce session JSON. The HTTP server and SDK expose session creation, retrieval, update, deletion, abort, and child-session operations. None of the current rules, CLI, SDK, or tools references documents learned-memory extraction or a memory management endpoint. [OpenCode CLI](https://opencode.ai/docs/cli/) and [OpenCode SDK](https://opencode.ai/docs/sdk/)

Mcode should treat OpenCode instruction files and resumed sessions as distinct context sources. Calling either one “memory” would hide an important capability gap.

## Implications for a hybrid Mcode memory broker

1. **Keep provider memory provider-owned.** Mcode should not import native memories into its database or silently rewrite their files. The native stores have different scopes, review rules, retention policies, and ownership models.
2. **Model context sources, not a universal memory record.** A thread receipt should identify provider-native memory, checked-in instructions, resumed history, and Mcode-approved cross-provider notes separately.
3. **Use a capability handshake.** Each adapter should report whether it can detect use, control contribution, control recall, expose citations, open a management surface, or reset data. Unsupported means unavailable, not a best-effort guess.
4. **Version-gate native controls.** Codex app-server methods are the strongest integration seam but remain experimental. Gemini Auto Memory depends on its host surface. Cursor and Copilot have no documented memory API for Mcode to call.
5. **Reserve Mcode memory for explicit cross-provider continuity.** A candidate should require human approval, retain its source thread and provider, show the evidence used to derive it, declare its workspace scope, and record every later injection.
6. **Prefer checked-in instructions for shared rules.** `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, repository documentation, and ADRs are reviewable by a team and should outrank learned context.
7. **Prevent double injection.** Before a turn, Mcode should show which native and Mcode-owned sources will be active. A user must be able to disable Mcode notes without altering the provider's own store, and vice versa where the provider supports it.

## Exploration still required

- Capture protocol traces for each Mcode adapter to confirm which memory state or citations are observable in practice.
- Test Codex versions across the supported range for `thread/memoryMode/set`, `memory/reset`, and citation delivery.
- Verify Gemini Auto Memory behavior through the exact integration Mcode intends to host.
- Confirm whether Cursor Agent CLI consumes IDE-approved memories; current official CLI documentation does not say.
- Confirm whether the Copilot SDK exposes memory state indirectly in session context or events; current public documentation does not define such a contract.
- Define how Mcode deduplicates an approved cross-provider note when the selected provider may already know the same fact.
