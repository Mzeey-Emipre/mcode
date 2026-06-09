---
status: accepted
---

# External-terminal launch does not share the server's ShellEnvResolver

## Context

An architecture review of the open-in app surface proposed sharing the
server's `ShellEnvResolver` with a desktop external-terminal launch path, to
avoid re-implementing shell selection. `ShellEnvResolver` lives in the server
process because it resolves the **login shell and merged environment for the
embedded PTY** — the in-app terminal.

"Open in Windows Terminal / Git Bash / WSL", by contrast, launches an
**external** terminal emulator. Those programs set up their own environment and
are started by spawning their executable with a working-directory argument
(`wt -d <dir>`, `wsl --cd <dir>`, `git-bash --cd=<dir>`). That is the same shape
as the per-editor launch arguments the open-in app registry already models.

## Decision

External-terminal launch is an ordinary **Open-in app registry** adapter:
detect the terminal executable, launch it with the target directory. It does
**not** share, import, or RPC into `ShellEnvResolver`, which stays a PTY-only
concern. There is no cross-process coupling between desktop-main and the server
for this feature.

We deliberately forgo **environment parity** between the in-app PTY and an
externally launched terminal: an external terminal behaves like the user's
normal terminal, resolving its own environment.

## Consequences

- The terminal app kind folds into the registry alongside editors, the git GUI,
  and File Explorer — no shared package and no server round-trip.
- The previously "speculative" candidate to share `ShellEnvResolver` is closed;
  future architecture reviews should not re-raise it.
- If environment parity between the in-app PTY and external terminals is ever
  wanted, it is an additive enhancement layered on the adapter, not a reversal
  of this decision, and should be recorded separately.
