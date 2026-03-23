# Performance Audit Checklist

Performance principles for building a fast, memory-efficient Electron + React app. Inspired by what high-performance native editors (Zed, Sublime) get right. Use this as a recurring checklist when reviewing code or adding new features.

---

## 1. Virtualize All Scrollable Lists

Any list that can grow beyond ~30 items must use virtual scrolling. Only DOM nodes visible in the viewport (plus a small overscan) should exist.

**Do:**
- Use a virtualizer (`@tanstack/react-virtual`, `react-window`, etc.) for dynamic-length lists
- Set a fixed or estimated item height for the virtualizer
- Add overscan (2-5 items) for smooth scrolling

**Don't:**
- Render all items with `.map()` inside a scrollable container
- Rely on `max-height` + `overflow-y: auto` as a substitute for virtualization
- Assume a list will stay small forever

**How to verify:**
- Open React DevTools, inspect a scrollable container, scroll to the bottom. DOM node count should stay constant regardless of list length.
- Chrome DevTools Performance tab: DOM node count in any scrollable area should stay under ~500 regardless of data size.

---

## 2. Memoize Expensive Components

Components inside frequently-updating parents should be wrapped in `React.memo()`. Expensive render logic (markdown parsing, syntax highlighting, computed layouts) should use `useMemo`.

**Do:**
- Wrap list item components in `React.memo()` so they skip re-rendering when their props haven't changed
- Use `useMemo` for expensive transformations (e.g. markdown-to-HTML parsing)
- Use `useCallback` for event handlers passed as props to memoized children

**Don't:**
- Let a parent re-render cause every child in a list to re-render
- Re-parse markdown or re-run syntax highlighting on every render when the source text hasn't changed
- Recreate component config objects (e.g. custom renderers) inside render

**How to verify:**
- React DevTools Profiler: record a session, trigger a state change, check "Why did this render?" on sibling items. They should show "Did not render" if their props didn't change.

---

## 3. Keep IPC Lean (Electron Main <-> Renderer)

Every `ipcRenderer.invoke()` serializes and deserializes JSON. Minimize the frequency and size of IPC calls.

**Do:**
- Batch related data into a single IPC call instead of multiple small ones
- For high-frequency streaming data (>60 events/sec), implement a batching window (e.g. 16ms / one frame) before forwarding to the renderer
- Use `MessagePort` or `SharedArrayBuffer` for high-throughput channels (terminal output, streaming responses)
- Enable context isolation and disable node integration
- Validate inputs on all IPC boundaries

**Don't:**
- Send individual IPC messages for every token, keystroke, or terminal byte
- Pass large objects (full file contents, entire conversation history) through IPC when only a delta is needed

**How to verify:**
- Add temporary IPC message counting in the main process during heavy workloads. If sustained >100 messages/sec, implement batching.

---

## 4. Lazy-Load Heavy Modules and Panels

Only load what's needed at startup. Defer everything else until the user needs it.

**Do:**
- Use `React.lazy()` + `Suspense` for panels and views not visible on initial render (settings, terminal, secondary tabs)
- Dynamic `import()` for heavy libraries only used in specific features (terminal emulators, markdown parsers, diagram renderers)
- Code-split at route/panel boundaries

**Don't:**
- Eagerly import large libraries at module level if they're only used conditionally
- Load all features at startup "just in case"
- Ship a single monolithic JS bundle

**How to verify:**
- Run a bundle visualizer (`rollup-plugin-visualizer`, `webpack-bundle-analyzer`). No single eagerly-loaded chunk should exceed 500KB.
- Track startup time: measure time from `app.ready` to first meaningful paint.

---

## 5. Avoid Layout Thrashing

Never interleave DOM reads and DOM writes. Batch all reads first, then all writes.

**Do:**
- Read layout properties (`scrollHeight`, `getBoundingClientRect`, `offsetWidth`) before making any style changes
- Use `requestAnimationFrame` to defer writes to the next frame if reads and writes can't be separated
- Use CSS for auto-sizing where possible (e.g. `field-sizing: content` for textareas)

**Don't:**
- Write a style, immediately read a layout property, then write again (e.g. `height = "auto"` -> read `scrollHeight` -> write `height`)
- Call `getBoundingClientRect()` in a loop that also modifies styles
- Trigger forced synchronous layouts inside scroll or resize handlers

**How to verify:**
- Chrome DevTools Performance tab: record interactions, look for repeated purple "Layout" bars >1ms. These indicate forced reflows.

---

## 6. Use Fine-Grained Store Selectors

When using state management (Zustand, Redux, etc.), components should subscribe to the smallest slice of state they need.

**Do:**
- Use selectors: `useStore((s) => s.specificField)`
- Split stores by domain (settings, threads, UI state) rather than one mega-store
- Derive computed values with selectors, not in components

**Don't:**
- Subscribe to the entire store: `useStore()` with no selector
- Subscribe to a parent object when you only need one field
- Trigger re-renders in unrelated components by mutating shared objects

**How to verify:**
- `grep` for bare store hook calls without selector arguments. Every usage should have `(s => ...)`.
- React DevTools Profiler: after a state change, only components that use the changed field should re-render.

---

## 7. Stream Responses Efficiently

For AI/LLM response streaming, accumulate text on the backend and send complete snapshots to the renderer. Avoid token-by-token DOM updates.

**Do:**
- Accumulate streamed tokens into a buffer on the backend/main process
- Send the full accumulated text (or meaningful deltas) to the renderer at a throttled rate
- Use immutable state updates (spread into new array) for message lists

**Don't:**
- Forward every individual token as a separate event to the renderer
- Concatenate strings in a loop on the renderer side (creates GC pressure)
- Re-render the entire message list on every token

**How to verify:**
- During streaming, measure time per state update in the store. Each update should be <2ms.
- Check that only the actively-streaming component re-renders, not all siblings.

---

## Scoring Guide

When running this audit, score each category:

| Score | Meaning |
|-------|---------|
| Pass | Meets the principle across all relevant code |
| Warning | Mostly good, but has known gaps that don't yet cause measurable issues |
| Fail | Measurable performance impact, needs a fix |

---

## Related

- Performance issues are tracked on GitHub with the `perf` label
- Run this checklist before major releases and after adding new list-based UI or heavy features
