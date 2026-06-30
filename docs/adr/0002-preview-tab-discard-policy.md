---
status: accepted
---

# Preview tabs are discarded (renderer killed), not frozen, and the active tab is protected only while the panel is visible

## Context

The in-app browser preview keeps a live renderer per tab. Background tabs are
already throttled (`setBackgroundThrottling(true)`), but nothing ever releases a
background tab's renderer, and hiding the panel or switching threads leaves
renderers resident. Warm-tab count is unbounded, so a session that visits several
pages or threads accumulates renderer processes and blows the < 150MB idle-memory
target. ADR-0016 lets the live renderer be hosted by either `WebContentsView` or
`webview`; this discard policy applies to both hosts.

We want modern-browser "memory saver" behaviour. Two questions drove real
trade-offs:

1. **Discard vs freeze.** A frozen tab keeps its renderer (instant resume, state
   intact) but frees little memory. A discarded tab kills the renderer (reclaims
   the memory) but reloads on return, losing scroll position and form input.
2. **When is the active tab safe to reclaim?** The active tab is what the user is
   looking at, so it must stay warm - but only while the panel is actually on
   screen.

A prior attempt at idle teardown was removed in #454 because a `ResizeObserver`
flapped the panel's `visible` flag on every SPA in-page navigation, hiding and
re-showing the view and causing reload churn. That history constrains any
time-based reclaim we add.

## Decision

Reclaim memory by **discarding** background tabs (kill the renderer, keep a cold
placeholder of title/URL/favicon), not by freezing them. Re-warming reloads the
page; scroll and form state are intentionally not preserved. This matches Chrome
Memory Saver / Edge sleeping-tabs discard semantics.

Discard is host-agnostic. For `WebContentsView`, discard destroys the native
guest view. For `webview`, discard releases the adopted guest and lets the
renderer-owned element unmount. In both cases the tab keeps the same cold
metadata and reloads on re-warm.

The discard policy is a pure function of (warm tabs, active thread/tab, panel
visibility, clock). It is visibility-aware:

- **Panel visible:** the active tab is protected and never discarded. Background
  tabs are discarded only after an idle threshold; the warm-tab count cap is **not**
  enforced, so the user's working set stays snappy.
- **Panel hidden:** the active tab loses its protection and competes like any other
  tab. After an idle delay the warm set is trimmed to the N most-recently-used tabs
  (steady state = N warm, as a fast-reopen cache, not zero).

Time-based reclaim carries **hysteresis**: a discard scheduled when the panel hides
is cancelled if the panel reappears within the window. This is the direct mitigation
for the #454 flap class.

## Considered Options

- **Freeze instead of discard (rejected).** Preserves scroll/form state, but a frozen
  renderer still holds most of its memory, so it does not meet the idle-memory target -
  the entire reason for the feature.
- **Discard everything to zero when hidden (rejected).** Maximum reclaim, but every
  reopen reloads even the tab the user just left. Keeping N warm as a reopen cache is
  the better point on the curve.
- **Enforce the count cap while visible too (rejected).** Would discard a background
  tab the user is actively toggling between, reloading it on return mid-task. The cap
  is a hidden-panel concern; while visible, idle-eviction alone bounds the set.
- **Discard the active tab the instant the panel hides (rejected).** Reintroduces the
  #454 churn: the `visible` flag is known to flap. Hysteresis plus an idle delay is
  required.

## Consequences

- Re-warming a tab is a full reload. Scroll position, form input, and in-page client
  state do not survive a discard. This is by design; preserving them would require a
  freeze (insufficient memory savings) or heavyweight state serialization (separate,
  larger effort).
- A discarded `file:` preview whose file was deleted re-warms into the preview error
  state (file-not-found). Discard and error handling compose through the same page
  state.
- The policy must persist a tab's validated current URL before disposing its renderer,
  or re-warm loads a blank page. The window-teardown park path already models this.
- The thresholds (warm-tab count N, background idle, hidden-panel idle) are user
  settings, not constants, so the memory/responsiveness balance is tunable without code
  changes.
- If a future product decision wants scroll/form preservation, it is a freeze tier
  layered on top - not a reversal of this decision - and should be recorded separately.
