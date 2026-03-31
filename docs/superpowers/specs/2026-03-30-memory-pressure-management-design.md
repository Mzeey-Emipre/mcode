# Lifecycle-Aware Memory Pressure Management

Target idle memory under 100MB across all idle states (cold, warm, background).

## Problem

Current idle memory target is < 150MB. The app makes no effort to constrain V8 heap size, tune SQLite caching, or reclaim memory when idle. Electron apps are notorious for high baseline memory; without active management, Node.js and Chromium both over-allocate and hold onto memory they no longer need.

## Idle States

| State | Definition | Trigger |
|-------|-----------|---------|
| **Cold idle** | App just launched, no agent running | App startup complete |
| **Warm idle** | Workspace open, thread visible, no agent running | Agent stops + 30s debounce |
| **Background idle** | App window unfocused/minimized | `blur` event + 60s debounce |
| **Active** | Agent running or user interacting | Agent start, `focus` event, or user input |

Transitions: Cold idle -> Active (user opens workspace) -> Warm idle (agent finishes) -> Background idle (user switches away). Any state can return to Active immediately.

## Design

### Layer 1: V8 Heap Caps (Cold Idle)

Constrain the maximum heap size for both the server child process and the Electron renderer so V8 never over-allocates.

**Server process** (`apps/desktop/src/main/server-manager.ts`):

Add V8 flags to the existing `execArgv` array in the `fork()` call:

```typescript
execArgv: [
  "--import", "tsx",
  "--max-old-space-size=96",
  "--max-semi-space-size=2",
  "--expose-gc",
],
```

- `--max-old-space-size=96`: Caps old generation at 96MB. The server holds SQLite, DI services, and agent state. 96MB provides headroom for 5 concurrent agents while keeping idle usage around 40-60MB.
- `--max-semi-space-size=2`: Reduces young generation from default 16MB to 2MB. Forces more frequent minor GC, keeping short-lived allocations (streaming tokens, tool call records) from accumulating.
- `--expose-gc`: Enables `global.gc()` for Layer 3 idle reclamation.

**Renderer process** (`apps/desktop/src/main/main.ts`):

Before `app.whenReady()`, add:

```typescript
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=128");
```

128MB for the renderer is generous for a single-page React app with virtual scrolling. This prevents Chromium's V8 from claiming excess heap during markdown rendering or Shiki highlighting.

**Estimated savings:** 20-40MB at cold idle. V8 default heap ceiling on 64-bit is ~2GB; capping it forces more aggressive internal GC.

### Layer 2: SQLite Memory Tuning (Cold Idle)

Reduce SQLite's memory footprint in `openDatabase()` (`apps/server/src/store/database.ts`):

```typescript
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("cache_size = -2000");  // 2MB page cache (negative = KB)
db.pragma("mmap_size = 0");       // Disable memory-mapped I/O
```

- `cache_size = -2000`: Reduces the page cache from the default (~8MB) to 2MB. Mcode's query patterns are simple key lookups and sequential scans on indexed columns; a 2MB cache provides sufficient hit rate.
- `mmap_size = 0`: Disables memory-mapped I/O. For a desktop app with a small database (typically < 50MB), mmap adds virtual memory overhead without measurable read performance benefit.

These PRAGMAs are set once at database open time and apply for the connection lifetime. Both are supported by better-sqlite3 via `db.pragma()`.

**Estimated savings:** 5-8MB baseline.

### Layer 3: MemoryPressureService (Warm + Background Idle)

A new server-side service that tracks idle state and applies progressive memory reclamation.

**File:** `apps/server/src/services/memory-pressure-service.ts`

```typescript
export class MemoryPressureService {
  private state: "active" | "warm-idle" | "background-idle" = "active";
  private warmIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundIdleTimer: ReturnType<typeof setTimeout> | null = null;

  // Called when agent starts or user sends a message
  markActive(): void;

  // Called when last agent finishes
  markIdle(): void;

  // Called via RPC from renderer on blur/focus
  markBackground(): void;
  markForeground(): void;
}
```

**Warm idle actions** (30s after last agent stops):

| Action | Implementation | Savings |
|--------|---------------|---------|
| SQLite shrink | `db.pragma("shrink_memory")` | 2-5MB |
| Manual GC | `global.gc()` (minor collection) | 10-20MB |

**Background idle actions** (60s after app loses focus):

| Action | Implementation | Savings |
|--------|---------------|---------|
| Full GC | `global.gc()` (full mark-sweep-compact) | 10-30MB |
| SQLite cache reduction | `db.pragma("cache_size = -500")` (500KB) | 1.5MB |

**Return to active:**

| Action | Implementation |
|--------|---------------|
| Restore SQLite cache | `db.pragma("cache_size = -2000")` |

The service is registered in the DI container and injected into `AgentService` (to call `markActive`/`markIdle` on agent start/stop). A new `memory.setBackground` RPC method handles renderer blur/focus notifications.

**Safety:** `global.gc()` blocks the event loop for 10-50ms. This is acceptable during idle (no streaming, no user interaction). The service checks that no agents are running before calling GC.

### Layer 4: Shiki Fine-Grained Bundle (Cold Idle)

Replace the full Shiki bundle with `shiki/core` plus explicit per-language imports. The full bundle (`shiki/bundle/full`, 6.4MB minified) statically registers all ~200 grammars. With `shiki/core`, only the engine and themes load at startup. Grammars are imported individually via `@shikijs/langs/*` packages.

**File:** `apps/web/src/workers/shiki.worker.ts`

Current:
```typescript
import { createHighlighter } from "shiki/bundle/full";
```

Proposed:
```typescript
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * Explicit grammar imports for languages commonly seen in agent output.
 * Each entry is a lazy import so Vite code-splits grammars into separate chunks.
 * Languages not in this map fall back to plain text rendering.
 */
const LANG_IMPORTS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  bash: () => import("@shikijs/langs/bash"),
  shell: () => import("@shikijs/langs/shell"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  yaml: () => import("@shikijs/langs/yaml"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  sql: () => import("@shikijs/langs/sql"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  diff: () => import("@shikijs/langs/diff"),
  toml: () => import("@shikijs/langs/toml"),
};
```

The existing `loadLanguage` call changes from passing a string name (which only works with the full bundle) to passing the resolved grammar module:

```typescript
const importFn = LANG_IMPORTS[language];
if (importFn) {
  const grammar = await importFn();
  await highlighter.loadLanguage(grammar as ShikiLang);
} else {
  lang = "text";
}
```

**Why not just `shiki/bundle/web`?** The web bundle (3.8MB) still includes grammars we don't need (Vue, Svelte, etc.) and excludes some we do (Dockerfile was the original trigger for switching to `bundle/full`). Explicit imports give us exactly the languages we want with no waste.

**Extending:** Adding a new language is a one-line addition to `LANG_IMPORTS`. No other changes needed.

**Estimated savings:** 3-6MB of worker heap (grammar objects for unused languages are never allocated). Bundle size reduction from 6.4MB to ~1.5MB (engine + themes + 16 grammars).

### Layer 5: Frontend Idle Reclamation Hook (Background Idle)

A React hook that listens for window blur/focus and coordinates with the server.

**File:** `apps/web/src/hooks/useIdleReclamation.ts`

```typescript
export function useIdleReclamation(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onBlur = () => {
      timer = setTimeout(() => {
        // Notify server to enter background-idle
        rpc("memory.setBackground", { background: true });
        // Evict client-side caches
        useThreadStore.getState().clearToolCallRecordCache();
      }, 60_000);
    };

    const onFocus = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      rpc("memory.setBackground", { background: false });
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
```

**Client-side eviction on background idle:**

| Cache | Store | Action |
|-------|-------|--------|
| Tool call records | `threadStore.toolCallRecordCache` | Clear entirely (re-fetched on expand) |

The tool call record cache is currently cleared as a side effect of `loadThread`. We add a dedicated `clearToolCallRecordCache` action that resets only `toolCallRecordCache` to `{}` without affecting messages, streaming state, or other thread data. Records are re-fetched from the server when the user expands a tool call after returning to the app.

This hook is mounted once in the root `App` component.

<<<<<<< HEAD
### Layer 6: Terminal Buffer Management (Warm Idle)

Non-visible terminal instances hold scrollback buffers in memory. When a terminal tab is not active, clear its buffer.

**File:** `apps/web/src/components/terminal/TerminalView.tsx`

Current scrollback is set to 500 lines. Each terminal instance uses approximately 1-3MB depending on content.

On terminal tab switch (when a terminal becomes non-visible):
- Call `terminal.clear()` on the outgoing terminal to release its scrollback buffer
- Historical scrollback is lost; only new PTY output appears when the terminal becomes visible again
- This is an acceptable trade-off: scrollback is 500 lines and terminals are primarily used for real-time agent output, not historical review

This is implemented in the terminal tab switching logic, not as a timer-based approach, so there is no delay.

**Estimated savings:** 1-3MB per hidden terminal instance.
=======
### Layer 6: Terminal Buffer Management (Background Idle)

Non-visible terminal instances hold scrollback buffers in memory. Each terminal instance uses approximately 1-3MB depending on content.

**Implementation:** Terminal buffer clearing is handled inside `useIdleReclamation` as part of the background idle sequence. After 60 seconds of window blur, the hook dispatches a `mcode:clear-terminal-buffers` CustomEvent. Each `TerminalView` instance listens for this event and calls `terminal.clear()` to release its scrollback buffer.

**Why background idle, not tab switch:** Per-terminal savings (1-3MB) do not justify degrading tab-switch UX. Clearing on tab switch loses scrollback that the user may want to review when switching back during an active session. Background idle clearing aligns with the "reclaim when nobody's looking" philosophy: the user is not present to notice the loss of scrollback, and any relevant output will resume flowing when they return.

**Behavior:**
- Clearing fires once per background idle entry, 60s after blur
- All mounted `TerminalView` instances clear simultaneously via the broadcast CustomEvent
- Historical scrollback is lost; only new PTY output appears after the user returns
- The PTY session itself remains alive on the server; only the frontend buffer is cleared

**Estimated savings:** 1-3MB per terminal instance during background idle.
>>>>>>> origin/main

## New Files

| File | Purpose |
|------|---------|
| `apps/server/src/services/memory-pressure-service.ts` | Idle state machine, GC triggers, SQLite cache management |
| `apps/web/src/hooks/useIdleReclamation.ts` | Window blur/focus listener, server notification, client cache eviction |

## Modified Files

| File | Change |
|------|--------|
| `apps/desktop/src/main/server-manager.ts` | Add V8 flags to `execArgv` |
| `apps/desktop/src/main/main.ts` | Add `app.commandLine.appendSwitch` for renderer heap cap |
| `apps/server/src/store/database.ts` | Add `cache_size` and `mmap_size` PRAGMAs |
| `apps/server/src/container.ts` | Register `MemoryPressureService` |
| `apps/server/src/services/agent-service.ts` | Call `markActive`/`markIdle` on agent lifecycle |
| `apps/server/src/transport/ws-router.ts` | Add `memory.setBackground` RPC handler |
| `apps/web/src/workers/shiki.worker.ts` | Switch from `shiki/bundle/full` to `shiki/core` |
| `apps/web/src/app/App.tsx` | Mount `useIdleReclamation` hook |
| `apps/web/src/stores/threadStore.ts` | Add `clearToolCallRecordCache` action |
| `apps/web/src/components/terminal/TerminalView.tsx` | Clear scrollback after 60s background idle |

## Estimated Impact

| State | Current (est.) | After | Target |
|-------|---------------|-------|--------|
| Cold idle | ~120-150MB | ~70-90MB | < 100MB |
| Warm idle | ~130-170MB | ~80-100MB | < 100MB |
| Background idle | ~130-170MB | ~50-70MB | < 80MB |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `--max-old-space-size=96` too tight during 5 concurrent agents | Monitor OOM crashes; increase to 128 if needed. Each agent session uses ~5-10MB. |
| `global.gc()` causes noticeable pause | Only called during verified idle (no agents, no user interaction). Minor GC takes 5-20ms; full GC 20-50ms. |
| SQLite cache reduction slows queries | 2MB cache with simple key-lookup patterns gives >95% hit rate. Validate by varying `PRAGMA cache_size` / `PRAGMA mmap_size` and measuring query latency; use `sqlite3_db_status(SQLITE_DBSTATUS_CACHE_HIT / CACHE_MISS)` via a native addon or the memstat extension for precise counters. |
| Shiki core import breaks language loading | Existing on-demand loading pattern already works; the full bundle just pre-registers grammars we never use. |
| Terminal clear loses scrollback | Scrollback is only 500 lines; content comes from PTY output which continues to flow. Users can scroll up after re-focus. |

## Testing

- **Unit test** the `MemoryPressureService` state machine (idle transitions, timer debouncing, no GC during active agents)
- **Integration test** SQLite PRAGMA changes (verify `cache_size` and `shrink_memory` execute without error on better-sqlite3)
- **Manual measurement** using Chrome DevTools Memory tab and `process.memoryUsage()` logging:
  - Measure baseline before changes
  - Measure after each layer is applied
  - Verify < 100MB at warm idle with a workspace open and 1 thread loaded

## Non-Goals

- Lazy DI resolution: All 13 services are lightweight singletons. The memory savings (~2-5MB) don't justify the added complexity of lazy proxies.
- React route splitting: The app uses a single-page component architecture without React Router. There are no routes to split.
- WebSocket compression: Message sizes are small (< 10KB typical). Compression overhead outweighs savings.
