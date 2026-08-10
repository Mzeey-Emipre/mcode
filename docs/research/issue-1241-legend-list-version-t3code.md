# Legend List 3.3.3 boundary and current T3 Code usage

## Answer

`@legendapp/list` 3.3.3 does not contain the `ScheduledWork` code that failed in the Mcode prototype. Version 3.3.4 adds that code and the unbound browser cancellation call. The specific `TypeError: Illegal invocation` path is new in 3.3.4.

Current T3 Code uses a patched, exact pin of `@legendapp/list` 3.3.3 in its web and mobile apps. It does not use TanStack Virtual in current application source. T3 Code replaced TanStack Virtual with Legend List in April 2026.

## Legend List version boundary

### Confirmed facts

- The npm metadata for 3.3.3 points to Git commit [`728ec738`](https://github.com/LegendApp/legend-list/commit/728ec7389f2c36ddd69383b3432aa9ffa213ce4a). The [3.3.3 registry record](https://registry.npmjs.org/@legendapp%2flist/3.3.3) gives the same `gitHead`.
- The npm metadata for 3.3.4 points to Git commit [`a9960684`](https://github.com/LegendApp/legend-list/commit/a9960684557a2e33aa394727db3ea0536824e90c). The [3.3.4 registry record](https://registry.npmjs.org/@legendapp%2flist/3.3.4) gives the same `gitHead`.
- The [complete upstream comparison](https://github.com/LegendApp/legend-list/compare/728ec7389f2c36ddd69383b3432aa9ffa213ce4a...a9960684557a2e33aa394727db3ea0536824e90c) adds `src/core/ScheduledWork.ts`. Version 3.3.3 has no such file or class.
- Commit [`26822d6b`](https://github.com/LegendApp/legend-list/commit/26822d6bad811385cdaa2d5ed0f70d58ff810d06) adds the shared scheduler. Commit [`fcd1e730`](https://github.com/LegendApp/legend-list/commit/fcd1e73014b42c75dc6cce72dd298033b58894ab) routes unmount cleanup through it.

### Exact failure

The 3.3.4 scheduler stores browser functions as tuple values:

- [`clearTimeout` is stored at line 23](https://github.com/LegendApp/legend-list/blob/a9960684557a2e33aa394727db3ea0536824e90c/src/core/ScheduledWork.ts#L19-L32).
- [`cancelAnimationFrame` is stored at line 37](https://github.com/LegendApp/legend-list/blob/a9960684557a2e33aa394727db3ea0536824e90c/src/core/ScheduledWork.ts#L35-L45).
- [`cancel()` calls the tuple member as `work[1](work[0])`](https://github.com/LegendApp/legend-list/blob/a9960684557a2e33aa394727db3ea0536824e90c/src/core/ScheduledWork.ts#L52-L57).

That call uses the tuple as the function receiver. It does not use the browser global object as the receiver. Chromium rejects the call for `cancelAnimationFrame` with `TypeError: Illegal invocation`.

The Mcode stack passes through `cancelScrollCompletionChecks`. The 3.3.4 source cancels `checkFinishedScrollFrame` first during this cleanup ([lines 5 to 9](https://github.com/LegendApp/legend-list/blob/a9960684557a2e33aa394727db3ea0536824e90c/src/core/cancelImperativeScroll.ts#L5-L10)). `checkFinishedScroll` registers that key through `ScheduledWork.frame` ([line 31](https://github.com/LegendApp/legend-list/blob/a9960684557a2e33aa394727db3ea0536824e90c/src/core/checkFinishedScroll.ts#L17-L32)). Thus, the browser callback on the observed active-frame path is `window.cancelAnimationFrame`.

The 3.3.4 unmount effect calls `cancelImperativeScroll(state)` and then `state.scheduledWork.dispose()` ([lines 804 to 809](https://github.com/LegendApp/legend-list/blob/a9960684557a2e33aa394727db3ea0536824e90c/src/components/LegendList.tsx#L804-L809)). The recorded stack fails in `ScheduledWork.cancel`, before disposal.

### Why 3.3.3 does not have this failure

Version 3.3.3 keeps the animation-frame handle on state. It calls the browser function directly:

- [`checkFinishedScroll` assigns the frame handle directly](https://github.com/LegendApp/legend-list/blob/728ec7389f2c36ddd69383b3432aa9ffa213ce4a/src/core/checkFinishedScroll.ts#L17-L32).
- The 3.3.3 cleanup uses direct `cancelAnimationFrame(...)` and `clearTimeout(...)` calls ([lines 782 to 793](https://github.com/LegendApp/legend-list/blob/728ec7389f2c36ddd69383b3432aa9ffa213ce4a/src/components/LegendList.tsx#L782-L793)).

The exact receiver-loss path is therefore absent from the 3.3.3 source and package output. This is a source-level conclusion. This research did not rerun the Mcode benchmark with 3.3.3.

## Current T3 Code

The source snapshot is T3 Code commit [`0a7c662d`](https://github.com/pingdotgg/t3code/commit/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7), dated 2026-08-10.

### Package and patch

- The web app pins [`@legendapp/list` to `3.3.3`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/web/package.json#L24).
- The mobile app pins [`@legendapp/list` to `3.3.3`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/mobile/package.json#L52).
- The workspace [registers a package patch for 3.3.3](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/pnpm-workspace.yaml#L124-L129). Its source is [`patches/@legendapp__list@3.3.3.patch`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/patches/%40legendapp__list%403.3.3.patch). The patch adds app-specific inset, keyboard, end-anchor, first-paint, and row-transition behavior. T3 Code therefore does not use the pristine 3.3.3 package.

### Components that use Legend List

Web components:

- [`MessagesTimeline`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/web/src/components/chat/MessagesTimeline.tsx#L575-L595)
- [`BranchToolbarBranchSelector`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/web/src/components/BranchToolbarBranchSelector.tsx#L785)
- [`ModelPickerContent`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/web/src/components/chat/ModelPickerContent.tsx#L714)
- [`FontFamilyPicker`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/web/src/components/settings/FontFamilyPicker.tsx#L238)

Mobile components:

- [`ThreadFeed` uses `KeyboardAwareLegendList`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/mobile/src/features/threads/ThreadFeed.tsx#L1820-L1908).
- [`HomeScreen`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/mobile/src/features/home/HomeScreen.tsx#L1142-L1155)
- [`ArchivedThreadsScreen`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx#L629)
- [`ThreadNavigationSidebar`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx#L1223-L1280)

`ChatView` owns a `LegendListRef`, but `MessagesTimeline` renders the web chat list. Mobile thread-list rows also use Legend List's recycling-state hook.

### TanStack Virtual status

Current T3 Code has no direct `@tanstack/react-virtual` dependency or import in application source. Its current TanStack packages serve other purposes, such as routing and pacing.

This was an explicit migration. [Pull request 1953](https://github.com/pingdotgg/t3code/pull/1953) replaced TanStack Virtual in the web chat timeline and branch selector. The merge commit removed `@tanstack/react-virtual` from the web manifest and lockfile ([package diff](https://github.com/pingdotgg/t3code/commit/96c9306dbd9fac8dff76133da0a19ab44de7caec#diff-913e2288afffe4d6f69bfe0e74cd557e31def4750ed604881d0e0c654744108d)). T3 Code had first added TanStack Virtual for large chat threads in commit [`5cf140b0`](https://github.com/pingdotgg/t3code/commit/5cf140b0ee2d7320d101b082217a90afb7f230ce).

T3 Code also uses the `Virtualizer` exported by `@pierre/diffs/react` in [`FilePreviewPanel`](https://github.com/pingdotgg/t3code/blob/0a7c662d39329eeb3cffe00d66a31f1a8241b3d7/apps/web/src/components/files/FilePreviewPanel.tsx#L644-L696). That is not TanStack Virtual.

## Why T3 Code chose Legend List

### Confirmed project rationale

[Pull request 1953](https://github.com/pingdotgg/t3code/pull/1953) states these goals:

- Delegate stick-to-bottom behavior to the list library.
- Remove custom scroll and measurement code.
- Reduce full-list rerenders through stable row identities and row-local subscriptions.
- Use one virtualized-list wrapper for the chat timeline and large branch lists.

[Pull request 3545](https://github.com/pingdotgg/t3code/pull/3545) later adopted Legend List's AI-chat, anchored-end, floating-composer, and keyboard-aware APIs. It states the user-visible requirements: keep the scrollbar full-height, keep the composer clear of the final message, follow streamed output only at the live edge, and preserve history position when the mobile keyboard opens.

[Pull request 5449](https://github.com/pingdotgg/t3code/pull/5449) upgraded web to 3.3.3. It replaced more manual offset correction with `maintainVisibleContentPosition`, `maintainScrollAtEnd`, and promise-based `scrollToIndex` behavior.

[Pull request 4867](https://github.com/pingdotgg/t3code/pull/4867) gives the mobile performance reason for 3.3.3. Its long-thread rows ranged from 49 pixels to more than 4,000 pixels. Version 3.3.3 batched row measurements and fixed stale end-scroll retries. T3 Code then rebased its app-specific patch on that version.

### Inference

T3 Code's choice is not evidence that Legend List is universally faster than TanStack Virtual. Its source and pull requests show a stronger fit for its combined web and React Native chat requirements. Built-in end maintenance, visible-content preservation, anchored end space, keyboard support, and cross-platform APIs removed app-owned logic.

The same evidence also shows a cost. T3 Code carries a large package patch and app code that works around list-specific inset, initial-scroll, and row-transition behavior. Mcode does not share T3 Code's React Native keyboard requirement. Mcode must judge Legend List on its own Electron and web behavior.

## Decision impact for issue 1241

Do not use the 3.3.4 crash to reject 3.3.3. The failing scheduler does not exist in 3.3.3. A clean 3.3.3 rerun can answer the performance and behavior question.

Do not copy T3 Code's adoption decision without its constraints. T3 Code chose Legend List to own a broad, cross-platform chat-scroll contract and then patched it. Mcode currently compares a web and Electron timeline, so it needs an unpatched 3.3.3 result against the current TanStack implementation.
