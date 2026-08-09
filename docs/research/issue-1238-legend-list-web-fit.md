# Legend List web fit for Mcode timelines

Research snapshot: 2026-08-09. Scope: `@legendapp/list` v3 web entrypoint for Mcode’s React timeline and other virtualized renderer surfaces. This note does not assess `@legendapp/state`.

## Decision

Treat Legend List as a conditional prototype candidate. Do not replace Mcode’s `@tanstack/react-virtual` timeline from documentation claims alone.

The web entrypoint now maps to the core timeline problem. It is DOM-native, supports React web, measures variable-height rows, and exposes chat, prepend, tail, and imperative-scroll primitives. The fit is incomplete because Mcode also requires exact per-thread scroll restoration, gesture-gated history loading, tail settling while markdown grows, sticky-preview coordination, and no-flash thread switches.

Run a side-by-side prototype against the current `MessageList`. Adopt only if the candidate passes every behavior contract and improves live traces in both standalone web and Electron Chromium. Keep the current implementation if the candidate is neutral, regresses a contract, or moves work into a less observable library-owned path.

## Source facts

### Legend List web and React support

- Legend List v3 documents a DOM-native React web entrypoint: `@legendapp/list/react`. The web guide says it has no React Native components or dependencies and supports Chrome, Safari, Firefox, Edge, and modern browsers with current React support. A contained list needs a real height, and flex parents often need `minHeight: 0`. [Web getting started](https://www.legendapp.com/open-source/list/v3/react/getting-started/)
- The v3 migration guide calls web support first-class and lists DOM-native rendering, the shared virtualization core, and web examples. The same page says the v3 documentation is marked beta. [v3 migration](https://www.legendapp.com/open-source/list/v3/migration/)
- The package has a separate `./react` export. Its package metadata declares `react: "*"` as a peer, `react-dom` as an optional peer, and uses React 19.1 plus `react-dom` 19.2 in its development dependencies. Mcode uses React and React DOM 19.2.4. This is positive version evidence, not a formal React 19.2 support guarantee. [package metadata](https://raw.githubusercontent.com/LegendApp/legend-list/main/package.json) [React 19](https://react.dev/blog/2024/12/05/react-19)
- The repository README still lists “React DOM implementation” as an unchecked roadmap item while the v3 docs and package export provide a web implementation. This is a documentation consistency risk, not proof that the web entrypoint is absent. [repository README](https://github.com/LegendApp/legend-list#upcoming-roadmap) [package exports](https://raw.githubusercontent.com/LegendApp/legend-list/main/package.json)

### Dynamic height and measurement

- `keyExtractor` is strongly recommended. Legend List uses stable keys to retain item layouts when data changes. The docs warn that index keys can attach cached measurements and recycled state to the wrong row after a prepend or reorder. [API reference](https://www.legendapp.com/open-source/list/v3/api/) [performance guide](https://www.legendapp.com/open-source/list/v3/performance/)
- Dynamic rows are a supported path. `estimatedItemSize` is an initial allocation hint, with a default of 100 pixels. The list uses measured sizes and averages after rows render. `getFixedItemSize` skips measurement only for genuinely fixed rows. `onItemSizeChanged` reports measured changes, and `setItemSize` lets an integration publish a size that changed outside normal layout measurement. [API reference](https://www.legendapp.com/open-source/list/v3/api/) [performance guide](https://www.legendapp.com/open-source/list/v3/performance/)
- The web implementation uses DOM containers, absolute positions, and `ResizeObserver`-based layout work. Its source applies `contain: paint layout style` to positioned rows and coalesces DOM scroll events with `requestAnimationFrame`. [web list source](https://github.com/LegendApp/legend-list/blob/main/src/components/ListComponentScrollView.tsx) [positioned row source](https://github.com/LegendApp/legend-list/blob/main/src/components/PositionView.tsx)

### Prepend and visible-content anchoring

- `onStartReached` and `onStartReachedThreshold` provide a built-in top-load trigger. The threshold is a percentage of screen size, not a fixed pixel distance. The guide recommends `maintainVisibleContentPosition={{ data: true }}` for prepend flows and says callers must guard duplicate loads. [infinite scrolling guide](https://www.legendapp.com/open-source/list/v3/guides/) [API reference](https://www.legendapp.com/open-source/list/v3/api/)
- `maintainVisibleContentPosition` defaults to size/layout stabilization with data anchoring disabled. `true` enables both; an object can select `data` and `size`, and `shouldRestorePosition` can skip specific rows. [API reference](https://www.legendapp.com/open-source/list/v3/api/) [v3 migration](https://www.legendapp.com/open-source/list/v3/migration/)
- The web core keeps a short-lived keyed anchor lock while data and delayed layout changes settle. The source uses stable item keys and an anchor position, then releases the lock after quiet passes or a timeout. [MVCP source](https://github.com/LegendApp/legend-list/blob/main/src/core/mvcp.ts)
- The public API does not expose Mcode’s exact `messageId` plus DOM `top` anchor snapshot as a first-class callback. `onFirstVisibleItemChanged` reports the first visible item, and `getState().indexByKey(key)` resolves a key to its current index, but the integration must test whether those signals cover Mcode’s required pixel-level restore after delayed markdown measurement. [API reference](https://www.legendapp.com/open-source/list/v3/api/) [CHANGELOG](https://raw.githubusercontent.com/LegendApp/legend-list/main/CHANGELOG.md)

### Tail anchoring and restoration

- `alignItemsAtEnd` bottom-aligns short content. `initialScrollAtEnd` starts a chat/feed at the last item and is designed to work with dynamic measurement, async data, and end-inset changes. `maintainScrollAtEnd` follows the end while the viewport remains within `maintainScrollAtEndThreshold`, which defaults to 10 percent of screen size. Explicit trigger options cover data changes, layout changes, item-layout changes, and footer-layout changes. [chat guide](https://www.legendapp.com/open-source/list/v3/guides/) [API reference](https://www.legendapp.com/open-source/list/v3/api/)
- `scrollToEnd`, `scrollToIndex`, `scrollToOffset`, and `scrollItemIntoView` are available through the list ref. `getState()` exposes live state, including `isAtEnd`; `alwaysRender` can keep selected rows mounted by key or index. [API reference](https://www.legendapp.com/open-source/list/v3/api/)
- `contentInsetEndAdjustment` adds real trailing DOM space for an externally measured floating composer or overlay. `anchoredEndSpace` reserves space after a selected row and reports when its size is authoritative. These primitives cover a floating composer, but Mcode must still coordinate its sticky last-user preview and top-inset compensation. [floating composer guide](https://www.legendapp.com/open-source/list/v3/guides/) [API reference](https://www.legendapp.com/open-source/list/v3/api/) [AI chat example](https://www.legendapp.com/open-source/list/v3/react/examples/ai-chat/)
- The public API has initial offset and imperative offset methods, but it has no per-thread scroll-memory store. Mcode must retain its thread-keyed `scrollTop`, `atTail`, `anchorMessageId`, and `anchorTop` state and decide when the list has loaded enough data to restore it. Legend’s guide recommends declarative initial scroll props instead of an effect, so the prototype must test late data arrival and thread reuse explicitly. [initial positioning guide](https://www.legendapp.com/open-source/list/v3/guides/) [API reference](https://www.legendapp.com/open-source/list/v3/api/)

### Recycling and row state

- `recycleItems` defaults to `false`. When enabled, Legend List reuses rendered item components. The docs warn that local item state can carry to another item and recommend recycling-aware hooks for state that must reset. The API specifically says recycling has a negligible effect on web compared with its React Native benefit. [API reference](https://www.legendapp.com/open-source/list/v3/api/) [performance guide](https://www.legendapp.com/open-source/list/v3/performance/)
- Mcode’s rows include expandable turn state, permission controls, narrative activity, streaming content, reply selection, and provider-driven state. Start the prototype with `recycleItems={false}`. Test recycling only as a separate experiment after every row-local state path has an explicit reset or an external keyed store.
- The web source omits the item key from the positioned component when recycling is enabled, which is the mechanism that permits component reuse. [container source](https://github.com/LegendApp/legend-list/blob/main/src/components/Container.tsx)

### Accessibility

- The web implementation renders the scroll surface and row-position containers as `div` elements. It forwards web props to the scroll surface and marks only internal spacer elements `aria-hidden`. It does not document or add list, row, or feed semantics for application content. Mcode must preserve its own message labels, controls, focus behavior, and live-region choices in the row renderer. [web list source](https://github.com/LegendApp/legend-list/blob/main/src/components/ListComponentScrollView.tsx) [positioned row source](https://github.com/LegendApp/legend-list/blob/main/src/components/PositionView.tsx)
- The official web chat examples add accessible labels to their own buttons and inputs. This supports the conclusion that accessibility is owned by the caller, not supplied by Legend List. [chat example](https://www.legendapp.com/open-source/list/v3/react/examples/chat/)

### Bundle cost

- npm metadata for v3.3.4 reports one runtime dependency, `use-sync-external-store`, and an unpacked package size of 2,209,016 bytes. The package tarball is 422,418 bytes in the research snapshot. [npm package](https://www.npmjs.com/package/@legendapp/list/v/3.3.4) [package metadata](https://raw.githubusercontent.com/LegendApp/legend-list/main/package.json)
- A local measurement of the [official v3.3.4 tarball](https://registry.npmjs.org/@legendapp/list/-/list-3.3.4.tgz) found the web ESM entry `react.mjs` at 318,630 bytes raw and 66,893 bytes gzip. This is a package-entry measurement, not the final Vite chunk. Measure the built Mcode chunk because tree shaking, shared dependencies, and app code change the delivered cost.

### Maintenance signals and known limits

- v3.3.4 was released on 2026-08-09. Its release notes include fixes for continued tail following after content growth, stale rows after `dataKey` changes, web content-container sizing, and interrupted programmatic scrolls. [v3.3.4 release](https://github.com/LegendApp/legend-list/releases/tag/v3.3.4) [CHANGELOG](https://raw.githubusercontent.com/LegendApp/legend-list/main/CHANGELOG.md)
- v3.3.3 fixed batched row measurements, edge-trigger bounce after data changes, and a one-frame wrong-item flash during prepend. v3.1.0 fixed web visible-content anchoring during header changes, browser scroll anchoring, and animated `scrollToEnd`. These fixes are positive activity signals and also show that the exact timeline contracts are active maintenance areas. [CHANGELOG](https://raw.githubusercontent.com/LegendApp/legend-list/main/CHANGELOG.md)
- The repository has open reports for at-bottom semantics under estimate re-layout (#492), prepend jumps with rows taller than estimates (#491), initial-scroll flicker with `onStartReached` (#486), a web chat drag-scroll jank report on mobile browsers (#488), a configurable tail re-pin delay for streaming (#470), visible unmount/remount during prepend (#450), and web blank output after invalidating data (#448). Open issue titles are reports, not proof that every environment reproduces the issue. [Legend List issues](https://github.com/LegendApp/legend-list/issues/492) [#491](https://github.com/LegendApp/legend-list/issues/491) [#486](https://github.com/LegendApp/legend-list/issues/486) [#488](https://github.com/LegendApp/legend-list/issues/488) [#470](https://github.com/LegendApp/legend-list/issues/470) [#450](https://github.com/LegendApp/legend-list/issues/450) [#448](https://github.com/LegendApp/legend-list/issues/448)
- The docs label v3 beta, while npm publishes 3.3.4 and the release stream is active. Treat the web API as usable but still subject to change. Pin the version and keep a focused behavior harness if Mcode adopts it. [web docs](https://www.legendapp.com/open-source/list/v3/react/getting-started/) [releases](https://github.com/LegendApp/legend-list/releases)

## Mcode comparison

### Current Mcode contract

`apps/web/src/components/chat/MessageList.tsx` uses `@tanstack/react-virtual` over mixed `ChatVirtualItem` rows. It supplies stable item keys, dynamic `measureElement`, an estimated size, overscan, a custom range extractor, and a custom item-size scroll-adjust callback.

The custom code also owns behavior that a generic list cannot be assumed to preserve:

| Contract | Current behavior | Legend List mapping | Fit |
| --- | --- | --- | --- |
| Dynamic heights | Measures rows and compensates while markdown, narrative, and streaming content change. | Dynamic measurement, `onItemSizeChanged`, `setItemSize`. | Strong candidate. Test delayed reflow. |
| Stable keys | `ChatVirtualItem.key` survives appends and prepends. | `keyExtractor` retains layout caches. | Direct fit. |
| History prepend | Upward wheel intent, 200 px threshold, first-visible message plus DOM-top snapshot, rAF settle, and retained prior range. | `onStartReached` plus `maintainVisibleContentPosition={{ data: true }}`. Threshold is screen-relative and the anchor is library-owned. | Partial. Adapter and trace gate required. |
| Tail pinning | 64 px tail threshold, wheel-up pause, streaming follow state, size-change compensation, and a 4-frame or 60-frame settle loop. | `maintainScrollAtEnd`, `initialScrollAtEnd`, `alignItemsAtEnd`, and footer/layout triggers. | Strong for basic chat. Partial for Mcode’s exact pause and settle rules. |
| Thread restoration | Thread-keyed pixel and message-anchor memory. Restore waits for the selected transcript, hides the list during positioning, then settles the anchor. | `initialScrollOffset` or `scrollToOffset` plus Mcode memory and `dataKey`. | Partial. Keep Mcode logic. |
| Sticky last-user preview | External overlay, measured top inset, DOM/virtualizer fallback, and scroll compensation when the inset changes. | Caller-owned overlay; `alwaysRender` can keep a target row mounted; end-inset primitives do not solve the top overlay. | Partial. Keep overlay logic. |
| Mixed row types | Memoized renderer for messages, narrative, tools, permissions, hooks, streaming, and footers. | `renderItem`, stable keys, optional `getItemType`. | Direct fit with recycling off. |
| Accessibility | Message rows own semantics and controls. | Web list containers are `div` elements; caller owns semantics. | Preserve current row markup and test with an accessibility tree. |

### Inference

Legend List can plausibly remove much of Mcode’s size-position bookkeeping for the common path. It cannot be assumed to remove the thread switch and streaming policy layer. The likely architecture is a thin Mcode adapter around Legend’s list engine, not a replacement of the timeline’s state and interaction logic.

## Fair comparison design

Use one prototype harness with two list engines. Keep the message builder, row renderer, Zustand selectors, transport fixtures, overlays, viewport, CSS, and browser profile identical. The Legend candidate must use `@legendapp/list/react`, `keyExtractor={(item) => item.key}`, immutable data updates, and `recycleItems={false}` for the first comparison. Add `getItemType={(item) => item.type}` only if it does not alter row behavior.

Run each case in standalone web and Electron Chromium:

1. Cold open with 100, 500, and 2,000 mixed rows. Include short text, long markdown, code blocks, tool calls, nested narrative rows, and a streaming row.
2. Warm thread switch with no saved offset, a saved tail position, and a saved history anchor. Assert no stale-thread flash and exact final anchor placement.
3. Scroll upward with a wheel gesture, prepend delayed batches, and grow the first visible row after the prepend. Assert the same message ID and pixel top remain within a fixed tolerance.
4. Stream text at the tail while the final row grows. Repeat after wheel-up. Assert tail follow, pause behavior, new-content affordance, and no forced return to the tail.
5. Toggle the sticky last-user preview and change its measured height. Assert that the reading position does not jump and that keyboard and pointer controls remain reachable.
6. Jump to a distant message, then append and resize nearby rows. Assert the target is visible, keys remain attached to the same content, and no blank window appears.

Record cold and warm first-render time, first 100-row load time, DOM descendant count, React commit duration and count, changed-row count during streaming, main-thread tasks over 50 ms, layout work over 1 ms, dropped-frame or long-frame intervals, list settle frames, anchor displacement, and built eager-chunk gzip size. Run enough repetitions to report median and p95, and retain traces for both engines.

Use Mcode’s existing budgets as gates: first 100 messages under 50 ms, eager web chunks at or below 500 KiB gzip, fewer than 500 descendants in a virtual viewport, and no main-thread task over 50 ms. Add behavior gates for every row and scroll contract in the table above. Do not accept a faster benchmark if it fails an anchor, restore, accessibility, or streaming assertion.

## Recommendation

Prototype Legend List v3.3.4 behind a comparison-only surface. Start with recycling disabled and keep Mcode’s thread scroll memory, wheel-intent gate, sticky preview, and accessibility markup. Use the current Mcode implementation as the baseline and require live traces from standalone web and Electron before any production migration decision.

The evidence supports a targeted experiment, not a production replacement. The web implementation is real and capable, but its beta documentation and active open issues overlap directly with Mcode’s hardest timeline contracts.
