# Thread Overview and right panel

## Sub-features

- In normal split mode, Thread Overview defaults open and stays visible when the right panel opens and narrows the chat pane, even below the usual narrow-pane threshold.
- When the right panel is hidden, a narrow chat pane defaults Thread Overview closed until the user opens it. An explicit user close or open choice always wins.
- The right-panel `rail-maximize-toggle` maximizes the panel within the app. It is not native window fullscreen.
- While maximized, the chat surface and Thread Overview are intentionally unavailable.
- Restoring the panel returns to split mode. Opening Thread Overview there keeps it visible beside the panel.

## How to get to it (user or client POV)

1. Start from a healthy runtime and a fresh owned Electron session at the product default 1200x800 window size (`apps/desktop/src/features/desktop-window/lifecycle/create-window.ts`). Assert `window.innerWidth === 1200`; if the session reuses another size, disconnect from and stop that exact owned Electron session, start a fresh owned Electron session, reconnect, and assert `window.innerWidth === 1200` again. If the fresh session still differs, report the hidden+narrow leg as an environment gap. Create or select the fresh disposable thread before any layout actions, so Thread Overview has no explicit local close/open choice.
2. Inspect `[data-testid="header-panel-toggle"]` and its `aria-pressed`. If it is `true`, close the panel through the public panel control and wait until it is `false`; do not click the Overview trigger. With the panel hidden, inspect the chat width and assert the initial Overview state: a narrow chat is closed (`aria-expanded="false"` and no Overview body), while a non-narrow chat is open with `[data-testid="thread-overview-body"]` or `[data-testid="thread-overview-masthead"]` visible.
3. If `aria-pressed="false"`, open the right panel through `[data-testid="header-panel-toggle"]`; otherwise leave it open. Assert `[data-testid="right-panel"]` is visible and the trigger is `aria-pressed="true"`. In either case, assert Overview is visible beside the panel (`aria-expanded="true"` and its body or masthead present), including when the narrowed chat is below the usual threshold.
4. Inspect `[data-testid="rail-maximize-toggle"]` and activate it only when its accessible name is `Maximize panel`; assert the panel is maximized and the chat surface and Overview are unavailable. Do not treat this as native window fullscreen.
5. Activate the same control only when its accessible name is `Restore panel` to return to split mode. Assert the panel is visible beside chat, then confirm Overview is visible beside it. Use `[data-testid="rail-panel-toggle"]` only for an explicitly required close action.
6. For the hidden+narrow proof, explicitly hide the right panel, wait for `aria-pressed="false"`, verify the chat is narrow, and assert Overview is closed before opening it through the workspace-menu trigger. Reopen the panel only after that assertion and confirm the explicit open choice remains visible beside the panel.

## Driving it with Electron Playwright

Use the stable `.agents/skills/electorn-live-testing` persistent Electron Playwright session. Do not add a repository harness or start the runtime from this feature proof.

- Run `runtime health` before collecting evidence. Continue only against the healthy, matching worktree instance.
- Drive public clicks and keyboard actions through the selectors above. Re-inspect the DOM after each layout transition.
- Capture stable assertions for `aria-expanded`, `aria-pressed`, the right-panel container, and Overview body or masthead. Capture screenshots for split mode with the panel open and Overview visible beside the narrowed chat, maximized panel mode without chat or Overview, and restored split mode under `.dev/verification/`.
- For cleanup, create the disposable managed-worktree thread through authenticated public `thread.create`, record its returned ID, then after proof call public `thread.delete` for that exact ID with `cleanupWorktree: true` and verify it is absent. Never delete by title or heuristic. Close UI state, disconnect Playwright, and stop only the Electron process owned by the session. Run `agent:down` only when this workflow started the runtime. Do not run live verification as part of documentation maintenance.

## Gotchas

- A maximized right panel must not be reported as showing Thread Overview. Its absence is the expected result.
- `rail-maximize-toggle` means panel maximize or restore, not native window fullscreen. Classify native fullscreen observations separately.
- A narrow pane with the right panel open is expected to show Overview by default. Treat visible+narrow+panel-open as the split-mode default, not a defect. If the right panel is hidden and a narrow pane starts open, or if an explicit user close/open choice is ignored, first classify the mismatch as a stale feature map only when the DOM contract has changed. Otherwise report it as an application defect.
- Classify stale or wrong runtime/build state as an environment failure; missing or contradictory selectors in the existing live interface as a harness defect; and missing proof for an intended state as a coverage gap. Update this feature file only for stale map entries, harness defects, or verifier-contract mismatches.
- This focused workflow covers the documented split, narrow, maximize, and restore states. It does not claim native fullscreen coverage or provider-specific behavior.
