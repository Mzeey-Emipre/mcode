# Issue #1049 viewport decision trace

## Current verdict

The current remediation diff matches the binding viewport model and accepted Variant B at the code and web-UI levels. It includes the exact presets and bounds, the accepted compact toolbar, keyboard and pointer drag handles, cooperative user-input invalidation, Regular-mode restore and reset, acknowledged native or renderer host operations, and stable preview mounting while the mode changes.

The implementation still lacks complete live acceptance evidence. The in-app Browser run passed the web viewport flow, including close and hide/remount behavior after the stable-mount repair. No provider-driven live run has proved normal completion restore or explicit interruption. Focused tests support those paths, but tests do not replace the live checks required by [issue #1049](https://github.com/Mzeey-Empire/mcode/issues/1049).

## Source and decision chain

The binding chain is:

1. [ADR 0018](../adr/0018-use-the-visible-preview-for-agent-browser-automation.md) establishes one visible Preview, typed operations, per-tab serialization, generation checks, and runtime capability honesty. [ADR 0016](../adr/0016-preview-rendering-host-switch.md) keeps Browser chrome React-owned while the selected Chromium host owns page rendering and main-process trust checks.
2. [Wayfinder #1029](https://github.com/Mzeey-Empire/mcode/issues/1029) closed all ten child decisions, then explicitly collapsed them into [specification #1042](https://github.com/Mzeey-Empire/mcode/issues/1042) in [comment 5150345996](https://github.com/Mzeey-Empire/mcode/issues/1029#issuecomment-5150345996).
3. #1042 makes the closed Wayfinder map and its resolutions authoritative. It also defines precedence: the later viewport decision refines earlier generic human-input wording. Ordinary cooperative input invalidates an observation; only explicit Stop or Take control advances control generation and interrupts execution.
4. \#1049 is the implementation ticket. Its blockers, [#1046](https://github.com/Mzeey-Empire/mcode/issues/1046) and [#1047](https://github.com/Mzeey-Empire/mcode/issues/1047), supply the admitted-step, receipt, generation, interruption, sticky-tab, provenance, and cleanup semantics that viewport operations must join.
5. [Viewport decision #1038](https://github.com/Mzeey-Empire/mcode/issues/1038#issuecomment-5148684503) owns viewport state and lifecycle semantics. [Prototype decision #1039](https://github.com/Mzeey-Empire/mcode/issues/1039#issuecomment-5149916700) owns the accepted visual treatment. The immutable accepted artifact is commit [`0592b9426cce8f0efc9c3f22c2c1baeeae9913a3`](https://github.com/Mzeey-Empire/mcode/commit/0592b9426cce8f0efc9c3f22c2c1baeeae9913a3), especially [`BrowserViewportPrototype.tsx`](https://github.com/Mzeey-Empire/mcode/blob/0592b9426cce8f0efc9c3f22c2c1baeeae9913a3/apps/web/src/components/panels/BrowserViewportPrototype.tsx).

The connected prototype decisions constrain, but do not redefine, viewport mechanics. [#1033](https://github.com/Mzeey-Empire/mcode/issues/1033#issuecomment-5149493062) permits an amber perimeter, cursor, and Browser rail icon during agent control, with no Browser header badge or local Stop capsule. [#1037](https://github.com/Mzeey-Empire/mcode/issues/1037#issuecomment-5149666428) keeps background Browser discovery in Thread Overview. [#1040](https://github.com/Mzeey-Empire/mcode/issues/1040#issuecomment-5149966875) assigns chronological receipts to the narrative timeline. The viewport toolbar must not become an agent-status or recovery surface.

## Binding viewport contract

### State, lifecycle, and receipts

- One coordinator belongs to one exact tab and serves user controls, agent operations, web, and Electron.
- Regular mode has no explicit CSS viewport. Responsive mode has one explicit CSS viewport.
- Responsive defaults to Fit. Fit uses a bounded 0.2 to 1.25 presentation scale. Actual renders at 100 percent and provides overflow navigation.
- Panel resizing changes presentation scale only. It never changes the confirmed CSS viewport.
- Requests include requested dimensions, source, operation identity, and target generation. Only the active host's matching acknowledgement can change confirmed state.
- Rapid requests coalesce so the newest wins. Clamped, failed, stale, and superseded results report the actual applied viewport.
- Only confirmed state stays with the tab across tab switches, Browser hiding, and ordinary remounts. Closing the tab removes it.
- Agent resize enters Responsive mode. On normal completion, Mcode restores Regular mode or the latest user-owned viewport choice. A user change during the run becomes the latest restore point without ending the run.
- Cooperative user activity invalidates old observations without ending the run. Explicit Stop or Take control interrupts, preserves the last confirmed viewport, and rejects late resize, presentation, or reset acknowledgements.
- The `browser_act` receipt model from #1046 applies: bounded steps, revision checks before the next effect, accurate stopping and effect classification, and no success-shaped stale result.

The shared runtime boundary remains narrow. `BrowserSessionDriver` owns policy and receipts; the broker owns credentials, routing, pending work, cancellation transport, and host liveness; the per-tab coordinator owns viewport state; web and Electron hosts apply dimensions or presentation and acknowledge the result. This applies ADR 0018's visible-host rule at [lines 7 to 17](../adr/0018-use-the-visible-preview-for-agent-browser-automation.md#L7-L17).

### Accepted Variant B details

Variant B is a calm device toolbar directly beneath the Browser header, opened from the Browser overflow menu. Its accepted details are:

- A single text trigger showing `Responsive` or the selected preset name.
- Presets: iPhone 15 Pro 393 x 852, Pixel 8 412 x 915, iPad Air 820 x 1180, Surface Pro 7 912 x 1368, Laptop 1280 x 800, and Desktop 1440 x 900. Menu rows show names and dimensions.
- Custom width and height inputs bounded from 240 through 2560 CSS pixels.
- An orientation-aware phone control that rotates between portrait and landscape.
- A scale trigger showing the applied percentage, with `Fit to panel` and `Actual size` in its menu.
- Side, bottom, and corner drag handles, with pointer capture and keyboard-accessible separator semantics.
- One close action that returns to Regular mode.
- No Agent badge in the Browser header or device toolbar.
- At narrow widths, one toolbar retains the same controls, removes redundant labels, and compresses fields. It does not clip actions, create horizontal page scroll, or introduce a second compact-only UI.

The prototype is binding for these meanings, not for production component structure. #1042 says prototype branches preserve design decisions only; production must use shared primitives and current architecture. The implementation uses shared `Button`, `Input`, and `DropdownMenu` primitives as required by the [UI component guide](../guides/ui-components.md#L1-L20).

## Remediation in the current diff

| Decision | Current implementation | Status |
| --- | --- | --- |
| Exact presets and bounds | [`viewportCoordinator.ts`](../../apps/web/src/services/browser-automation/viewportCoordinator.ts#L1-L22) defines the six accepted presets, 240 to 2560 dimensions, and Fit scale 0.2 to 1.25. | Implemented. |
| Accepted Variant B toolbar | [`BrowserViewportToolbar.tsx`](../../apps/web/src/components/panels/BrowserViewportToolbar.tsx#L37) shows `Responsive` or the selected preset, includes dimensions in preset rows, uses an orientation-aware phone control, shows percentage scale, exposes Fit and Actual in one menu, and compacts through container queries without wrapping. | Implemented. |
| Drag handles | [`BrowserViewportCanvas.tsx`](../../apps/web/src/components/panels/BrowserViewportCanvas.tsx#L17) adds side, bottom, and corner separators. It translates pointer movement through the presentation scale and supports arrow keys, with Shift for larger steps. | Implemented for renderer-owned canvases. |
| Cooperative input | Browser controls now call `invalidateBrowserAutomationObservationTarget` instead of interrupting the run in [`PreviewPanel.tsx`](../../apps/web/src/components/panels/PreviewPanel.tsx#L2943-L2993). [`BrowserSessionDriver.invalidateObservationsForTarget`](../../apps/web/src/services/browser-automation/browserSessionDriver.ts#L254-L264) invalidates observation bindings without changing control epoch. | Implemented. |
| Explicit takeover only | The header badge and local Stop capsule were removed from [`BrowserHeader.tsx`](../../apps/web/src/components/panels/BrowserHeader.tsx). The overflow menu now exposes the existing explicit `Take control` path in [`BrowserOverflowMenu.tsx`](../../apps/web/src/components/panels/BrowserOverflowMenu.tsx#L190-L214). | Implemented. |
| User restore point | `requestUserResize()` preserves active agent control while updating user-owned mode and confirmed size in [`viewportCoordinator.ts`](../../apps/web/src/services/browser-automation/viewportCoordinator.ts#L363-L383). | Implemented. |
| Regular restore and reset | `completeAgent()` restores the latest user mode. Regular mode submits a reset operation instead of only changing React state in [`viewportCoordinator.ts`](../../apps/web/src/services/browser-automation/viewportCoordinator.ts#L393-L401). Toolbar close uses the same coordinator path in [`PreviewPanel.tsx`](../../apps/web/src/components/panels/PreviewPanel.tsx#L3004-L3013). | Implemented. |
| Acknowledged host operations | [`viewportCoordinatorFactory.ts`](../../apps/web/src/services/browser-automation/viewportCoordinatorFactory.ts#L161-L213) checks operation identity and monotonic operation generation on native acknowledgements. The desktop host retains generation tombstones across reset, and interruption submits a newer reconciliation operation for the last confirmed viewport. The same factory routes presentation and reset through native or renderer adapters. | Implemented. |
| Confirmed tab state | The store retains per-tab confirmed state across detach/remount and clears it on unregister/close in [`browserAutomationStore.ts`](../../apps/web/src/stores/browserAutomationStore.ts#L152-L192). | Implemented. |

The diff also adds focused coverage for the canvas, toolbar, cooperative invalidation, completion restore, reset acknowledgements, stale and superseded reset outcomes, native presentation, and per-tab lifecycle. These tests lock in the corrected behavior but do not satisfy the live Electron and provider gates.

## Verification evidence

\#1049 requires live web and Electron checks for user resize, agent resize, panel resize, tab switching, hiding, remounting, normal completion, and interruption. #1034 adds the shared live tracer story for resize, background activity, narrative rendering, and return to visible control. The local UI guide separately requires interaction, keyboard, accessibility, responsive-width, console, visual checks, and focused tests at [lines 59 to 86](../guides/ui-components.md#L59-L86).

### Web live pass

The Playwright CLI suite passed one test with zero unexpected, skipped, or flaky results. The primary result is [results.json](../../.dev/verification/issue-1049-playwright-cli/results.json); [errors.json](../../.dev/verification/issue-1049-playwright-cli/errors.json) is empty. A later in-app Browser run repeated the binding controls against the same-origin fixture and exercised:

- iPhone 15 Pro preset selection and confirmed 393 x 852 inputs;
- custom 100 x 3000 input clamped to 240 x 2560;
- rotation to 2560 x 240;
- the percentage scale menu, Fit to panel, and Actual size;
- keyboard and pointer resize-handle paths;
- a 500 x 700 narrow viewport with every visible toolbar control contained inside the 452 x 44 toolbar;
- no document-level horizontal scroll;
- close returning the Browser to Regular mode and removing the device toolbar;
- Browser hide/remount preserving the confirmed 393 x 852 viewport;
- panel maximization changing Fit scale from 47 percent to 103 percent while the confirmed viewport stayed 852 x 393.

The containment assertion recorded no offending controls in [bounds.json](../../.dev/verification/issue-1049-playwright-cli/bounds.json). Screenshots in the same evidence directory capture the preset, clamped, and narrow states.

### Evidence still required

- **Electron:** The current worktree reached the Electron startup path, but another development instance occupied the default server port. The server-manager health check then observed that other instance before this worktree's lock was available, so the current native viewport UI never became usable. Desktop control was stopped from the keyboard after the startup error.
- **Provider lifecycle:** No live provider turn has proved agent resize, a cooperative user viewport change followed by normal completion restore, or explicit interruption with late-operation rejection.
- **Cross-state lifecycle:** The live flow does not cover native tab switching, Browser hiding/remounting during an active provider run, background activity, or narrative receipts.

These are verification gaps, not known code defects. \#1049's complete live acceptance gate remains open until those paths run successfully.

### Repository gates

- Monorepo typechecking passed across all six packages.
- The focused web suites passed 117 tests, and the exact PreviewPanel regression proved that the same iframe remains mounted while Responsive mode opens and closes.
- The desktop viewport suite passed 86 tests, including stale-operation admission across more than 128 live tabs. The contracts suite passed 301 tests.
- Typechecking and linting passed. Its unit-test phase timed out after eight unrelated sidebar-search tests failed because this runner had no usable `localStorage`. The issue-specific viewport suites passed independently.

## Background and superseded material

- ADR 0018, the web-dev spec, #1030, and the current `CONTEXT.md` glossary contain older generic wording in which direct user input interrupts control. #1042 expressly supersedes that wording for Browser v2 cooperative input.
- The accepted prototype's local React state, disposable query flag, fixture page, and variant switcher are prototype-only. Its control set, hierarchy, labels, compaction behavior, drag affordances, and presentation meanings are accepted.
- The safe Fit maximum began as a prototype question in #1038 and became 1.25 in the accepted artifact and #1042.
- #1037's prototype records only Thread Overview presentation. Its comment says production routing and data remain implementation work.
- #1033's focused and live checks passed, but its full repository verification timed out. That does not weaken the accepted visual decision; it limits the prototype's verification evidence.
