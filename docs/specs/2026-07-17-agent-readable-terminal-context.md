# Agent-Readable Terminal Context and Terminal Experience

**Date:** 2026-07-17
**Status:** Proposal
**Tracking issue:** [#874](https://github.com/Mzeey-Empire/mcode/issues/874)
**Research:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Mcode terminals are scoped to the correct Workspace or Worktree, but a Provider cannot reliably inspect what the user sees. Users must copy failed builds, server logs, and test output into the Composer. Copying loses command boundaries, exit status, working directory, truncation, and shell identity.

The terminal surface also falls below Mcode's instrument-grade design standard. Its renderer uses a generic monospace font, hard-coded colors, and no deliberate content inset or line-height system. Shell selection and appearance settings do not help users preserve richer prompts such as Starship. The surrounding shell list and toolbar spend space without establishing a clear hierarchy.

## Product outcome

Give the terminal one coherent upgrade. Users can attach a bounded snapshot of recent output or grant a visible, time-bounded watch. The terminal itself gains Mcode-aligned typography, spacing, color, shell identity, prompt-theme compatibility, and quieter chrome. Terminal content remains outside Provider context until the user shares it.

## Goals

- Attach recent output from one selected terminal to an unsent message.
- Preserve shell identity, working directory, command boundaries, timestamps, exit status, and truncation markers.
- Allow a running agent to watch one terminal under visible, revocable consent.
- Keep capture bounded in bytes, lines, duration, and update frequency.
- Redact protected environment values before data reaches the web app or provider.
- Align terminal chrome, spacing, typography, focus, and status with Mcode's design system.
- Preserve user shell profiles and render ANSI color, Unicode, and prompt glyphs accurately.
- Let users select an installed shell and terminal font without making Mcode own their prompt theme.

## Non-goals

- Giving an agent unrestricted access to terminal history.
- Reading terminals from another project or worktree.
- Treating terminal output as trusted instructions.
- Replacing structured test, lint, or server-health integrations.
- Bundling Starship, Oh My Posh, shell plugins, or a synthetic Mcode prompt.
- Rewriting command output to imitate the Codex reference screenshot.
- Decorative terminal motion, gradients, glow, or unrelated dashboard chrome.

## Visual direction

The terminal remains a dense technical instrument inside the right panel. It uses Mcode's slate surfaces and tokenized contrast rather than a disconnected near-black theme. Filament Amber appears only for focus, selection, or the next relevant action. ANSI colors retain their semantic meaning and meet the surrounding contrast requirements.

The output viewport uses a user-selectable monospace stack, a deliberate line height, and a 4 px-based inset that keeps text away from panel edges without reducing useful density. Selection, cursor, search matches, reconnect notices, process exit, and truncation each have a defined state. State never relies on color alone.

Terminal chrome has three levels:

1. The right-panel tab identifies the Terminal surface.
2. A compact shell header identifies the active shell, current scope, directory, and running or exited state.
3. A restrained shell switcher exposes other Shell sessions, creation, rename, and close actions.

The shell switcher and active header do not duplicate the same persistent actions. Destructive actions stay quiet until relevant. Narrow panels preserve the same Shell sessions and state through a compact switcher rather than replacing the terminal with a weaker workflow.

## Shell and prompt themes

The colorful Git branch prompt shown in the Codex reference comes from the user's shell configuration, often Starship, Oh My Posh, or a similar prompt. Mcode does not generate those prompt segments.

Mcode starts the selected installed shell in its normal interactive profile mode, preserves the resolved environment, declares compatible terminal capabilities, and renders 24-bit ANSI color, Unicode, and configured font glyphs. A terminal font setting accepts an installed family and provides a safe fallback stack. Users who select a Nerd Font can see prompt icons without Mcode shipping or silently substituting that font.

Shell selection is explicit and validated. Changing the default affects new Shell sessions, not running ones. The header shows the actual shell in use rather than a friendly label that could hide a fallback.

## User experience

Each terminal exposes **Attach recent output**. The action opens a preview containing the Shell session, working directory, most recent command boundary, exit state, and bounded tail. Users may trim the selection before adding it to the Composer. Nothing is sent until the message is submitted.

**Watch this terminal** grants the active Thread access to new bounded snapshots for a selected duration or until the current turn ends. The shell header shows the watching Thread and provides Stop sharing. A Thread can watch only one Shell session at a time, and a Shell session can be watched only by a Thread in the same Worktree.

When output exceeds a limit, Mcode retains the newest complete lines, marks omitted bytes and lines, and preserves the command boundary when it fits. Binary data, invalid control sequences, and terminal escape codes render as safe text or an explicit omission.

## Context contract

A terminal snapshot includes:

- terminal and worktree identity;
- shell and normalized working directory;
- capture time and watch state;
- recent command text when Mcode observed it;
- exit state or running state;
- sanitized text segments and omission counts.

The context must distinguish user input, process output, and Mcode metadata. Provider-visible framing states that terminal output is untrusted data and may contain prompt injection.

## Security and privacy

- Snapshot requests are authorized against the requesting thread and worktree.
- The server enforces all byte, line, rate, and duration limits.
- Protected environment values and known credentials are redacted before persistence or provider delivery.
- Raw terminal buffers are not added to thread history, logs, analytics, or crash reports.
- Watches end on thread completion, terminal close, worktree change, logout, app shutdown, or explicit revocation.
- Output cannot trigger tools, approvals, or shell writes by itself.

## Acceptance criteria

1. A user can preview and attach recent output from exactly one Shell session.
2. The attachment identifies its shell, directory, command state, capture time, and truncation.
3. The user can start and revoke a bounded watch, with persistent visible status while active.
4. Cross-Worktree and stale-session requests fail closed.
5. Large, rapidly updating, binary, and escape-heavy output stays within configured bounds and renders safely.
6. Protected values are removed before the snapshot reaches the web process or provider.
7. Provider context labels the snapshot as untrusted terminal output.
8. Closing a Shell session or finishing a turn ends its watch.
9. Existing terminal pause, resume, resize, reattach, and process behavior remains unchanged when sharing is off.
10. The terminal uses Mcode surface, text, focus, and status tokens rather than a separate hard-coded theme.
11. Output has a deliberate edge inset, readable line height, stable cursor, visible selection, and no clipped first or last line at supported panel sizes.
12. Users can choose an installed shell and font for new Shell sessions, and running sessions keep their resolved configuration.
13. Interactive shell profiles load normally, including user-configured Starship or Oh My Posh prompts.
14. ANSI 16-color, 256-color, 24-bit color, Unicode, box drawing, and configured prompt glyphs render without layout corruption.
15. The active shell header identifies actual shell, scope, directory, and process state without duplicating actions in the shell switcher.
16. Shell switching, panel hiding, Thread switching, and resizing preserve process state, scroll anchor, selection rules, and visual stability.
17. Keyboard focus, exited state, reconnect gaps, truncation, and watch state remain understandable without color.
18. The terminal stays usable at the minimum right-panel width and adapts without replacing Shell sessions with a weaker modal workflow.

## Verification protocol

- Unit-test truncation, complete-line retention, control-sequence handling, and redaction.
- Contract-test authorization, stale identities, rate limits, and cross-worktree rejection.
- Run a failing build, attach its output, and confirm the preview matches the visible terminal with explicit omission markers.
- Watch a development server, produce a new error, and confirm only the permitted bounded update reaches the active thread.
- Revoke the watch and confirm later output is unavailable.
- Capture before-and-after screenshots at minimum, typical, and wide right-panel widths in dark and light themes.
- Open PowerShell, PowerShell 7, Git Bash or WSL where installed, bash, and zsh on their supported platforms; verify the actual shell and profile behavior.
- Run ANSI 16-color, 256-color, truecolor, Unicode, box-drawing, long-line, alternate-screen, and Nerd Font fixtures.
- Verify a user-configured Starship or Oh My Posh prompt renders from the shell profile without Mcode-generated segments.
- Switch Shell sessions and Threads while reading history, then confirm the same scroll anchor and completed frame return without flash or layout shift.
- Use screenshot comparison to check content inset, row rhythm, toolbar hierarchy, focus, selection, exit, reconnect, and watch states against Mcode tokens and the Codex reference.
- Check keyboard paths, accessible names, contrast, reduced motion, and narrow-panel behavior.
- Run `bun run verify` after the live checks.

## Repository anchors

- `packages/contracts/src/terminal.ts`
- `apps/server/src/services/terminal-service.ts`
- `apps/server/src/services/agent-service.ts`
- `apps/web/src/stores/terminalStore.ts`
- `apps/web/src/components/terminal`

## Reference behavior

OpenAI documents a project-scoped terminal whose current output can be read by Codex in [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal). Mcode's proposal makes consent, scope, bounds, and truncation explicit while treating the reference screenshot as a standard for calm spacing and legibility. User-owned prompt theming remains separate from Mcode's terminal chrome.
