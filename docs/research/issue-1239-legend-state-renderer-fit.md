# Issue 1239: Legend-State fit for Mcode volatile renderer state

Checked 2026-08-09. This note answers the issue question with current primary-source evidence. It separates source facts from Mcode inferences. It does not recommend a production migration.

## Decision summary

Do not replace `threadStore` with Legend-State now. Keep the current Zustand store, `ConversationResidency`, and TanStack Virtual path as the baseline.

Run one bounded prototype only if live traces show that row updates inside the volatile narrative remain a bottleneck after the current batching and memoization work. The prototype should cover a small volatile narrative slice, such as a map of tool-call rows keyed by `toolCallId`, and should use `useValue` or an equivalent hook. Do not use `observer` or `enableReactTracking` in a React 19 build.

The likely migration seam is:

1. Keep `threadStore` as the event and lifecycle authority.
2. Project only volatile narrative rows into a separate observable model.
3. Subscribe each expensive row to its own observable value.
4. Keep chronology, turn boundaries, persistence, permission attribution, and conversation residency outside that prototype.

This is an inference from the current renderer shape and the Legend-State contracts below. It needs an Electron and standalone-web trace before adoption.

## Current Mcode facts

Mcode uses React `19.2.4`, Zustand `5.0.12`, and TanStack Virtual `3.13.23` in `apps/web/package.json`. The app already has a selector seam: `useThreadRecord` uses Zustand `useShallow`, while `readThreadRecord` and `readActiveThreadRecord` provide imperative reads. See [`apps/web/package.json`](../../apps/web/package.json), [`thread-selectors.ts`](../../apps/web/src/stores/thread-selectors.ts#L12-L58).

`ThreadRecord` contains both volatile turn data and durable-message projections. The record includes `messages`, `toolCalls`, `thoughtSegments`, `hooks`, `narrativeByMessage`, `answeredPlanMessageIds: Set<string>`, and `planAnswers: Map<string, PlanAnswer>`. `patchThreadRecord` clones the records `Map`, updates one record, and prunes message-linked indexes when transcript rows change. See [`thread-record.ts`](../../apps/web/src/stores/thread-record.ts#L82-L270).

The event path already coalesces `session.textDelta` chunks per thread and flushes them in one `requestAnimationFrame` update. It updates the streaming buffer and thought segments in one store transaction, while final-response chunks avoid thought-segment projection. See [`threadStore.ts`](../../apps/web/src/stores/threadStore.ts#L957-L1041) and [`threadStore.ts`](../../apps/web/src/stores/threadStore.ts#L2812-L2845).

The narrative pipeline keeps volatile tool calls, thoughts, and hooks through `turn.persisted`; the next turn clears them. The server owns durable messages and narrative metadata. See [`narrative-pipeline.md`](../guides/narrative-pipeline.md#renderer-ownership) and [`narrative-pipeline.md`](../guides/narrative-pipeline.md#trap-3-client-volatile-state-survives-turnpersisted).

`MessageList` selects separate record slices, builds stable and volatile virtual items, memoizes `VirtualItemRenderer`, and renders a single `narrative-flow` virtual item for the live timeline. TanStack Virtual limits mounted rows and preserves scroll anchors. See [`MessageList.tsx`](../../apps/web/src/components/chat/MessageList.tsx#L321-L367), [`MessageList.tsx`](../../apps/web/src/components/chat/MessageList.tsx#L575-L648), [`MessageList.tsx`](../../apps/web/src/components/chat/MessageList.tsx#L727-L770), and [`virtual-items.ts`](../../apps/web/src/components/chat/virtual-items.ts#L277-L325).

`NarrativeFlow` rebuilds its item list with `useMemo` when its tool-call, hook, thought, or streaming props change. It then maps those items inside one component. `DeltaBlock` uses a separate typewriter loop and keeps its cursor inside the React-owned tree. See [`NarrativeFlow.tsx`](../../apps/web/src/components/chat/narrative/NarrativeFlow.tsx#L129-L217) and [`DeltaBlock.tsx`](../../apps/web/src/components/chat/narrative/DeltaBlock.tsx#L114-L184).

## Legend-State source facts

### React 19 and React Compiler

The current Legend-State v3 documentation labels the line as a beta. Its migration guide says `observer` is not compatible with React Compiler because Compiler may memoize `get()` calls. The guide recommends `useValue`, which it describes as the renamed `useSelector` hook. It also says `enableReactTracking({ auto: true })` is broken in React 19 and is deprecated. See [Legend-State v3 migration guidance](https://legendapp.com/open-source/state/v3/other/migrating/#observer---usevalue).

The React documentation says the Compiler targets React 19 by default and supports React 17, 18, and 19. This confirms that Mcode's React version is within the Compiler's supported target range, not that every Legend-State consumption mode is compatible. See [React Compiler target](https://react.dev/reference/react-compiler/target) and [React Compiler introduction](https://react.dev/learn/react-compiler/introduction).

Legend-State's v3 React API describes `useValue` as tracking an observable or selector function and re-rendering only when its computed value changes. It says `observer` remains an optimization for combining multiple `useValue` calls, not the recommended direct `get()` path. See [Legend-State React API](https://legendapp.com/open-source/state/v3/react/react-api/#usevalue).

**Mcode inference:** A React 19 prototype must use `useValue`-style hooks and must not depend on automatic `get()` tracking. The package's own `main` branch still lists React `18.3.1` in development dependencies and overrides, with no React peer dependency in its package metadata. Therefore, React 19 compatibility is documented for the recommended hook path but still needs a Mcode React 19 build and runtime test. See the [Legend-State package metadata](https://github.com/LegendApp/legend-state/blob/main/package.json#L539-L566) and [its React development dependencies](https://github.com/LegendApp/legend-state/blob/main/package.json#L695-L741).

### Fine-grained updates and selectors

Legend-State tracks observable `get()` calls inside observing contexts. `peek()` reads raw data without tracking. `onChange` listens recursively, so its documentation says to use it as specifically as possible. See [reactivity and tracking](https://legendapp.com/open-source/state/v3/usage/reactivity/#what-tracks).

`useValue` accepts a selector function and re-renders only when the selector result changes. Computed functions inside observables are lazy and re-compute when observed dependencies change. The v3 migration guide warns that computeds only re-compute while observed, so side effects must not depend on an unobserved computed. See [computed observables](https://legendapp.com/open-source/state/v3/usage/observable/#computed-functions) and [v3 computed migration notes](https://legendapp.com/open-source/state/v3/other/migrating/#other-changes).

Legend-State's fine-grained model can update `Memo`, `Computed`, reactive props, and `For` children without re-rendering the parent. Its `For` component accepts arrays, objects, or `Map` observables. The `optimized` mode reuses React nodes and the documentation warns that this can behave unexpectedly with some animations or external DOM changes. See [fine-grained Reactivity](https://legendapp.com/open-source/state/v3/react/fine-grained-reactivity/) and [Legend-State performance guidance](https://legendapp.com/open-source/state/v3/guides/performance/#optimized-rendering).

**Mcode inference:** Legend-State could reduce work inside `NarrativeFlow` if each expensive row subscribes to a row-level observable. It does not replace TanStack Virtual, the stable/volatile item builder, or Mcode's scroll-anchor logic. The current timeline is one virtual item whose props are rebuilt from whole arrays, so a useful prototype must first create a row-level seam. Adopting `For` as a second list system would not be a drop-in replacement for the measured, anchored virtual list.

### Map and Set behavior

The v3 React docs explicitly include `Map` in the `For` collection contract. The current source also exposes `map` and `set` path types and has a dedicated `handlerMapSet` implementation. That handler provides observable `Map.get` and `Map.set` paths, shallow tracking for `size`, and handlers for `delete`, `clear`, and `Set.add`. See [`For` collection support](https://legendapp.com/open-source/state/v3/react/fine-grained-reactivity/#for) and the [official `ObservableObject.ts` source](https://github.com/LegendApp/legend-state/blob/main/src/ObservableObject.ts#L3632-L3715).

**Mcode inference:** Mcode's existing `Map` and `Set` values are representable, but the migration must replace `Map` cloning and mutation boundaries with observable methods. Any code that reads raw values or mutates the returned object directly can bypass notifications; Legend-State documents that raw-data mutation does not notify observers. See [observable mutability rules](https://legendapp.com/open-source/state/v3/usage/observable/#observables-are-mutable). Keep the current `Map` and `Set` fields in Zustand until a prototype proves key updates, deletion, clearing, hydration, and equality behavior under the real event stream.

### Batching and imperative access

Legend-State provides `batch`, `beginBatch`, and `endBatch`; batches postpone renders and listeners until the batch ends. Its performance guide also warns that automatic persistence can write once per change unless writes are delayed. See [batching](https://legendapp.com/open-source/state/v3/usage/reactivity/#batching) and [performance batching](https://legendapp.com/open-source/state/v3/guides/performance/#batching).

Observable values expose imperative `get`, non-tracking `peek`, and `set` operations. The docs warn that cloning raw data is unnecessary and that mutating raw data breaks notifications. See [observable methods](https://legendapp.com/open-source/state/v3/usage/observable/#get) and [observable mutability](https://legendapp.com/open-source/state/v3/usage/observable/#observables-are-mutable).

**Mcode inference:** Legend-State's batching is not a reason to remove Mcode's existing frame scheduler. Mcode's `requestAnimationFrame` flush bounds renderer work to a paint cadence and preserves final-response classification. If Legend-State is used, the event handler should enqueue provider deltas, then perform one `batch` inside the existing flush. Calling `set` once per provider event would regress the current contract.

Mcode's imperative consumers use Zustand's `getState()` for actions, hydration, workspace coordination, and event handling. An observable reference plus `get()` or `peek()` can cover reads, but actions, lifecycle guards, and server refresh contracts still need an explicit Mcode service or store API. This is a migration seam, not an automatic compatibility layer.

### Persistence and sync coupling

Persistence and remote sync are optional Legend-State features. `syncObservable` and `synced` add them to an existing observable, while the sync engine exposes load, error, pending-change, retry, and debounce state. See [persist and sync](https://legendapp.com/open-source/state/v3/sync/persist-sync/#syncobservable) and [synced observables](https://legendapp.com/open-source/state/v3/sync/persist-sync/#synced).

**Mcode inference:** Use plain `observable(...)` for a volatile renderer prototype. Do not use `synced`, `syncObservable`, or persistence plugins for tool calls, thoughts, hooks, or streaming text. Mcode's server owns durable messages and narrative metadata, while volatile turn state must survive `turn.persisted` and reset at the next turn. Legend-State persistence would add a second ownership path and could create writes for data that Mcode intentionally keeps in client memory.

### Bundle cost

Legend-State's official README claims a 4 KB size and marks the package as side-effect free. The repository also carries separate core, React, and sync bundle-size scripts, but the package metadata does not publish their measured output. Treat 4 KB as the project's claim, not as an independently verified Mcode bundle result. See the [official README](https://github.com/LegendApp/legend-state#readme) and [package scripts and metadata](https://github.com/LegendApp/legend-state/blob/main/package.json#L539-L605).

The npm registry currently reports stable `@legendapp/state` `2.1.15` and beta tag `3.0.0-beta.48`. The repository `main` package also declares `3.0.0-beta.48`. Mcode must choose whether a test uses the stable v2 API or the React-Compiler-oriented v3 beta; the v3 guidance and `useValue` recommendation do not describe the stable v2 line. See [npm package metadata](https://registry.npmjs.org/@legendapp/state) and [repository package metadata](https://github.com/LegendApp/legend-state/blob/main/package.json#L539-L547).

### Maintenance signals and known limitations

The repository is active: GitHub shows more than 3,000 commits, and the main branch history shows v3 beta commits and fixes in February 2026. The GitHub Releases page has no published releases, while the package publishes to npm. These are maintenance signals, not a stability guarantee. See the [repository](https://github.com/LegendApp/legend-state), [main branch history](https://github.com/LegendApp/legend-state/commits/main), and [releases page](https://github.com/LegendApp/legend-state/releases).

Known limits relevant to Mcode are:

- v3 is a beta and its migration guide records API and behavior changes, including the shift from `observer` to `useValue`, renamed computed APIs, and changed persistence APIs. See [v3 migration notes](https://legendapp.com/open-source/state/v3/other/migrating/).
- `observer` and `enableReactTracking` are the wrong paths for a React Compiler and React 19 build. Use `useValue` and test the exact Compiler configuration.
- Observable proxies add work while iterating large arrays. The performance guide recommends reading raw data with `get()` when tracking is not needed. See [proxy iteration guidance](https://legendapp.com/open-source/state/v3/guides/performance/#iterating-through-observables-creates-proxies).
- `For optimized` reuses React nodes and can interact poorly with animations or external DOM changes. Mcode's narrative rows include enter/exit animation and a measured typing cursor, so this mode needs a focused proof.
- `useObserve` runs during component render, not after render like `useEffect`. Do not move DOM, scroll, IPC, or persistence effects to it without a lifecycle review. See [React API effect timing](https://legendapp.com/open-source/state/v3/react/react-api/#useobserve).

## Evaluation contract

Before adopting any slice, compare these three variants with identical fixtures in Electron and standalone web:

1. Current Zustand selectors and frame-batched deltas.
2. A local targeted fix that preserves Zustand and the current virtual list.
3. A Legend-State row prototype using v3 `useValue`, plain non-synced observables, and the existing frame boundary.

Record React commit count, changed-row count, frame time, scroll-anchor stability, memory, and bundle delta. Exercise at least 100 messages, a long streaming response, parallel sub-agents, `Map` and `Set` changes, thread A to B to A switching, `turn.persisted`, reconnect replay, and a full reload. Reject the prototype if it changes event ownership, durable-data ownership, final-response classification, or scroll behavior.

## Sources

All external sources above are first-party Legend-State documentation or source, npm registry metadata, GitHub repository metadata, or React documentation. Mcode facts come from the linked files in this repository. The recommendation and migration seam are explicitly marked as Mcode inferences.
