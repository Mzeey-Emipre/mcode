# Performance Audit Checklist

_Last audited: 2026-03-23_

This document tracks performance patterns inspired by high-performance editors like Zed. Use it as a recurring checklist to catch regressions and identify improvements.

## Audit Categories

### 1. List Virtualization
All scrollable lists rendering dynamic content should use virtual scrolling (e.g. @tanstack/react-virtual) when item count can exceed ~30.

**Checklist:**
| Component | File | Virtualized? | Notes |
|-----------|------|-------------|-------|
| Message List | `apps/web/src/components/chat/MessageList.tsx` | ❌ No | `messages.map()` renders ALL messages. Critical — DOM node count is #1 Electron memory killer |
| Slash Command Popup | `apps/web/src/components/chat/SlashCommandPopup.tsx` | ✅ Yes | Uses @tanstack/react-virtual with 20-item threshold and overscan of 2 |
| File Tag Popup | `apps/web/src/components/chat/FileTagPopup.tsx` | ❌ No | `files.map()` renders all files in a max-h-[240px] container |
| Project Tree | `apps/web/src/components/sidebar/ProjectTree.tsx` | ❌ No | Renders all workspaces and threads — can reach 5000+ DOM nodes |
| Terminal Output | `apps/web/src/components/terminal/TerminalView.tsx` | ✅ Yes | xterm.js handles this natively with 500-line scrollback |
| Terminal List | `apps/web/src/components/terminal/TerminalList.tsx` | N/A | Typically 1-5 items, not a concern |

**How to verify:** Open React DevTools Profiler, load a conversation with 200+ messages, check DOM node count in Performance tab. Should stay under ~500 nodes in the message area.

---

### 2. Component Memoization
Components that receive stable props but live inside frequently-updating parents must use `React.memo`. Expensive render logic should use `useMemo`.

**Checklist:**
| Component | File | Memoized? | Notes |
|-----------|------|----------|-------|
| MessageBubble | `apps/web/src/components/chat/MessageBubble.tsx` | ❌ No | Re-renders on every message addition even if its own message didn't change |
| MarkdownContent | `apps/web/src/components/chat/MarkdownContent.tsx` | ❌ No | Runs react-markdown + remark-gfm on every render — expensive for large messages |
| ToolCallCard | `apps/web/src/components/chat/ToolCallCard.tsx` | ❌ No | Re-renders when parent updates |

**How to verify:** React DevTools Profiler → record a session where a new message streams in → check "Why did this render?" for MessageBubble components that didn't change.

---

### 3. IPC Efficiency (Electron Main ↔ Renderer)
Every `ipcRenderer.invoke()` serializes/deserializes JSON. High-frequency calls should be batched or use MessagePort.

**Checklist:**
| Pattern | Status | Notes |
|---------|--------|-------|
| Individual request/response calls | ✅ Clean | 36 handlers, each well-scoped |
| Agent event forwarding | ⚠️ Unbatched | Each sidecar event sent individually via `webContents.send()` |
| PTY data streaming | ⚠️ Unbatched | Terminal output forwarded per-event, no batching window |
| Context isolation | ✅ Enabled | `contextIsolation: true`, `nodeIntegration: false` |
| Input validation on IPC boundary | ✅ Present | All handlers validate inputs |

**How to verify:** In main process, add temporary logging to count IPC messages/sec during active agent streaming. If >100/sec, implement a 16ms (one frame) batching window.

---

### 4. Lazy Loading & Code Splitting
Heavy modules should be loaded on demand. Use `React.lazy()` + `Suspense` for route-level and panel-level splitting.

**Checklist:**
| Module | File | Lazy? | Bundle Size | Notes |
|--------|------|-------|-------------|-------|
| xterm.js | `TerminalView.tsx` | ✅ Yes | 404KB | Dynamic import on mount — good |
| react-markdown + remark-gfm | `MarkdownContent.tsx` | ❌ No | ~50KB | Eagerly imported at module level |
| cmdk | `ui/command.tsx` | ❌ No | ~15KB | Only used in WorktreePicker |
| Settings Dialog | `SettingsDialog.tsx` | ❌ No | Small | Eagerly imported in Sidebar |
| Composer | `ChatView.tsx` | ❌ No | 729 lines | Always loaded, largest component |

**Bundle sizes:**
- Desktop main bundle: **1.9MB** (target: <1MB with splitting)
- Web main bundle: **659KB** (target: <400KB with splitting)
- xterm chunk: 404KB (lazy ✅)

**How to verify:** Install `rollup-plugin-visualizer` in vite config, run build, inspect treemap for largest chunks. No single eagerly-loaded chunk should exceed 500KB.

---

### 5. Layout Thrashing
Never interleave DOM reads (e.g. `scrollHeight`, `getBoundingClientRect`) with DOM writes (e.g. `style.height = ...`). Batch reads first, then writes.

**Checklist:**
| Location | File | Issue |
|----------|------|-------|
| Textarea auto-resize | `Composer.tsx:83-92` | Sets `height = "auto"` then reads `scrollHeight` then writes `height` again — forces two layout passes |

**How to verify:** Chrome DevTools → Performance tab → record while typing in composer → look for purple "Layout" bars >1ms. Repeated forced reflows indicate thrashing.

---

### 6. Store Subscription Granularity
Zustand selectors should pick individual fields. Never call `useStore()` without a selector.

**Checklist:**
| Pattern | Status | Notes |
|---------|--------|-------|
| All stores use selectors | ✅ Yes | No bare `useStore()` calls found |
| Selector granularity | ✅ Good | Components select 1-2 fields each |
| Store count | ✅ Appropriate | 4 stores with clear separation |

**How to verify:** `grep -r "useThreadStore()" --include="*.tsx"` — any call without a selector argument `(s => ...)` is a problem.

---

### 7. Streaming Response Efficiency
AI response streaming should accumulate on the backend and send complete snapshots, not token-by-token updates to the renderer.

**Checklist:**
| Pattern | Status | Notes |
|---------|--------|-------|
| Backend text accumulation | ✅ Good | `lastAssistantText` accumulator in sidecar client |
| Frontend receives full text | ✅ Good | No token-by-token DOM updates |
| Message array immutability | ✅ Good | Spread operator for new array on each message |

**How to verify:** Add console.time/timeEnd around threadStore message updates during streaming — each update should be <2ms.

---

## Scoring Guide

Run this audit periodically. Score each category:
- ✅ **Pass** — meets target
- ⚠️ **Warning** — functional but has known optimization opportunities
- ❌ **Fail** — measurable performance impact, needs fix

| Category | Current Score | Target |
|----------|--------------|--------|
| List Virtualization | ❌ Fail (3/5 lists unvirtualized) | All lists >30 items virtualized |
| Component Memoization | ❌ Fail (0/3 key components memoized) | All frequently-rendered components memoized |
| IPC Efficiency | ⚠️ Warning (clean but unbatched streaming) | Batch high-frequency events |
| Lazy Loading | ⚠️ Warning (only xterm lazy) | All panels + heavy libs lazy-loaded, main bundle <500KB |
| Layout Thrashing | ❌ Fail (1 known instance) | Zero forced reflows |
| Store Subscriptions | ✅ Pass | Fine-grained selectors everywhere |
| Streaming Efficiency | ✅ Pass | Backend accumulation, no token-by-token renders |

---

## Related Issues

Performance issues are tracked as GitHub issues with the `perf` label.
