---
status: accepted
---

# Use the visible Preview for agent browser automation

Agents control the live page in Mcode's Browser instead of starting a second,
hidden browser. A provider receives a short-lived credential for its thread and
workspace. The server exposes a provider-neutral MCP interface, validates the
credential and operation, and routes each request to the Mcode client that owns
the requested Preview tab.

The renderer keeps the Browser automation host connected while the right panel
changes tabs or the user switches threads. It advertises live Preview targets
with replacement generations. The Electron main process executes typed,
high-level browser operations against the exact adopted page. Providers do not
receive raw Electron or Chrome DevTools Protocol access.

Browser control is explicit. Agent actions are serialized per tab. Direct user
input interrupts the active action and gives control to the user. Closing or
replacing a page, disconnecting a host, ending a provider session, or revoking a
credential cancels affected work.

Observability travels through bounded product operations: snapshots,
screenshots, console entries, network entries, accessibility data, performance
metrics, action history, evaluation, and detached DevTools for the user. Every
payload has a size or count limit, reports truncation where applicable, and
removes sensitive URL details before leaving the desktop boundary.

## Consequences

- The user and agent inspect and change one shared page state.
- Cursor, GitHub Copilot, Claude, and Codex use the same browser tool contract
  through their supported MCP integration.
- Plan mode receives observation tools. Build permissions determine whether a
  provider may interact with the page or run privileged evaluation.
- Live tabs and provider sessions require bounded registries, timeouts,
  cancellation, generation checks, and stale-target rejection.
- Browser recording and viewport resize are honest capabilities. A host omits
  or rejects them when its current Electron surface cannot support them.
- Browser tab persistence and memory pressure remain product concerns because
  automation does not create an independent browser lifecycle.
