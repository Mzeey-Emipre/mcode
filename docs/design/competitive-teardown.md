# Competitive Teardown: T3 Code & Synara

A grounded read of two direct peers, captured to sharpen Mcode's design and engineering direction. Both are Electron + Vite + TypeScript monorepos that use Effect-ts for the agent layer, so the patterns port more cleanly than usual.

- **T3 Code** (`pingdotgg/t3code`, ~12k stars, Theo / ping.gg) - a minimal GUI for coding agents (Codex, Claude, OpenCode). The engineering-rigor reference.
- **Synara** (`Emanuele-web04/synara`) - a fork of T3 Code that added a split-pane / right-dock / embedded-browser UI. The UI-pattern reference.
- **Zed** (`zed-industries/zed`) - a Rust editor on its own GPUI framework. **No code ports** (Rust/GPUI, not React/Electron); it is a *design and algorithm* reference only, read for its diff screen. Section 5.

File references point into the upstream repos, not Mcode. They are anchors for a real teardown, not import paths.

## How this feeds impeccable

The aesthetic and interaction findings (sidebar enrichments, right-dock pane strip, composer sigils, context meter, keyboard hints) inform `PRODUCT.md`'s References and the surfaces in `DESIGN.md`. The architecture and performance findings are an engineering backlog, not design context. Each item below is tagged so the line between "design" and "infra" stays clear.

---

## 1. Performance & optimisation `infra`

The Zed / Theo angle. Mapped to Mcode's targets: idle < 150MB, startup < 2s, first 100 messages < 50ms, bundle < 2MB, 60fps timeline.

### Steal

- **React Compiler (auto-memoization).** `apps/web/vite.config.ts` layers `@rolldown/plugin-babel` + `reactCompilerPreset()` on `@vitejs/plugin-react`. Auto-memoizes components, making Mcode's dozens of hand-written `memo()`/`useMemo()` in the chat timeline dead code. Direct 60fps lever. Biggest single win.
- **Virtualized message list.** They use `@legendapp/list` with `maintainScrollAtEnd` (`MessagesTimeline.tsx`, `ChatView.tsx`) instead of a mapped array + hand-rolled sticky-bottom scroll. Covers first-100-messages < 50ms and deletes scroll-position bookkeeping.
- **Highlight/diff worker pool, CPU-proportional + capped.** `DiffWorkerPoolProvider.tsx`: pool size `max(2, min(6, hardwareConcurrency/2))`, `tokenizeMaxLineLength: 1000`, `totalASTLRUCacheSize: 240`. Mcode's Shiki worker is a single worker - a capped pool with bounded LRU is a clean memory win.
- **`window.show: false` then reveal on `ready-to-show`.** `apps/desktop/src/window/DesktopWindow.ts` - no white-flash on launch, no artificial delay. Direct startup-perceived-latency win.
- **Lazy-load heavy panels.** `lazy(() => import("../components/DiffPanel"))` keeps syntax-highlighting + worker pool off the critical path.
- **`optimizeDeps.include` for Effect sub-paths + diff worker.** Cuts Vite cold-start churn in dev if Mcode uses Effect on the frontend.
- **Bundle the Electron main process to a single `.cjs`** (`vp pack`, `alwaysBundle` for workspace packages). Shortens the require chain at startup; helps < 2s.
- **`typecheck --concurrency-limit 2`.** Unbounded `tsc` parallelism across a monorepo exhausts memory on CI. Cap typecheck concurrency.
- **Custom oxlint rule `no-inline-schema-compile`** (`oxlint-plugin-t3code/rules/`). Forbids building/compiling schemas inside hot paths. Mcode's Zod analog: flag `Schema.parse` / `ZodSchema.parse` constructed inside component bodies or request handlers.

### Skip / already-have

- `vite-plus` internal build wrapper - not portable; Mcode's Bun + Vite is equivalent.
- Effect-ts in the Electron main process - high effort, no perf gain for Mcode's separate server process.
- Electron security defaults (`sandbox`, `contextIsolation`, `nodeIntegration: false`) - Mcode should already have these; not a perf item.
- No `manualChunks` anywhere - they trust Rolldown defaults and still hit bundle targets, because React Compiler + virtualization do the heavy lifting.

---

## 2. Architecture & provider abstraction `infra`

### Steal

- **`ProviderAdapterShape` - one typed interface across all providers.** `apps/server/src/provider/Services/ProviderAdapter.ts`: `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`, `listSessions`, `readThread`, `rollbackThread`, `streamEvents`. The contract surface Mcode should standardize across Claude / Codex / Copilot / Cursor / OpenCode.
- **`ProviderDriver` SPI as a plain record** (`driverKind`, `configSchema`, `defaultConfig`, `create`), with a registry owning the instance map. Multi-instance safe by construction (two Codex accounts, no singleton collision).
- **Snapshot-then-live-stream subscriptions.** Every `subscribe*` returns `Stream.concat(snapshot, liveStream)` (`apps/server/src/ws.ts`). Eliminates client race conditions on reconnect. Adopt for Mcode's thread/shell subscriptions.
- **Bidirectional stdio JSON-RPC over one pipe.** `packages/effect-acp/src/protocol.ts` multiplexes client- and server-initiated requests on a single stdin/stdout, so the agent subprocess can call back (file reads, permission prompts) without a second channel. Mcode's Codex provider already speaks JSON-RPC 2.0 over stdio - the callback half is the part to add.
- **Static RPC-scope authorization map.** `RPC_REQUIRED_SCOPE` + `authorizeEffect`/`authorizeStream` (`apps/server/src/ws.ts`). The map IS the auth policy; unmapped methods fail at startup. Adopt before any remote-access feature.
- **Extract a framework-agnostic `client-runtime` package** (theirs has no React imports: transport, subscriptions, keyed state). Worth doing in Mcode before a second client (mobile) makes the extraction expensive.

### Skip

- **Adopting Effect-ts wholesale** - `Queue`/`Ref`/`Stream`/`Layer` everywhere. Mid-project adoption is a rewrite. Extract the patterns above as principles without the runtime.
- **ACP as the universal provider protocol** - ACP (Agent Client Protocol) is Cursor/Anthropic-flavored; do not assume Codex / Copilot / Claude-API all normalize to it. T3 Code treats it as the canonical wire format; Mcode's per-provider adapters are a safer bet.
- **`packages/tailscale` / `packages/ssh`** - power their remote mesh/tunnel feature; off Mcode's roadmap.

### Notable

- Per-entity client state via `Atom.family(key)` + `AtomRegistry` (`packages/client-runtime`) instead of global stores - each thread/session gets a keyed atom, no global-merge re-renders. Relevant to Mcode's 5-agents-in-parallel isolation, even if implemented in Zustand rather than Effect atoms.
- `contracts` uses Effect `Schema`, not Zod - derivable codecs and typed error channels at the cost of the Effect learning curve. Mcode's `lazySchema`/Zod approach is the pragmatic equivalent.

---

## 3. UI: Synara's split-pane / right-dock / browser `design`

Synara added what T3 Code lacks: `splitViewStore`, `rightDockStore`, `BrowserPanel`, `WorkspaceView`, drag-to-split overlay, and sidebar enrichments.

### Steal

- **Right-dock pane strip.** `rightDockStore.ts`, `chat/RightDock.tsx`: per-thread tabs of kind `browser | diff | terminal | sidechat | git` (singleton per kind except sidechat). Chip-tab strip with `+` menu; expensive panes kept mounted across tab switches (`reconcileKeepMountedPaneIds`). This is the one tab form that fits Mcode - it lives on the right of a single thread, not over the sidebar.
- **Drag-to-split overlay.** `chat-drop-overlay/ChatPaneDropOverlay.tsx`: VS Code-style 4-quadrant drop zones, custom MIME guard (`application/x-t3-thread`, blocks file drops), 16ms rect cache to avoid `dragover` reflow. Adopt only as an opt-in "compare two threads" mode.
- **`splitViewStore` recursive pane tree.** `Pane = LeafPane | SplitNode`, depth-capped at 2, persisted; immutable helpers (`replacePaneInTree`, `removeLeafByPaneId`). Clean model if Mcode ever does split-compare.
- **Screenshot-to-composer in one call.** `BrowserPanel.tsx`: `api.browser.captureScreenshot` -> `addComposerDraftImage(threadId, ...)` lands a capture as a first-class attachment on the active thread. Validate Mcode's capture dock against this minimal flow.
- **Sidebar enrichments.** `ThreadRunningSpinner`, `ThreadPinToggleButton`, `SidebarMetaChip` (model / token count), `SidebarSearchPalette`. Low-effort, high-value for a sidebar-first product. (Keep them quiet - tinted dots and mono meta, per `DESIGN.md`, not colorful chips.)

### Skip / conflicts

- **A full tab bar over the conversation.** The sidebar IS Mcode's tab system; a second thread-nav surface destroys the glance wedge.
- **`WorkspaceView` (terminal-only top-level route).** Mcode's worktree model already covers this; a separate terminal workspace muddies "one sidebar row = one thing to monitor."
- **Right dock as a heavy, always-persisted second column.** Adopt the pane strip, but keep it collapsible and secondary; do not let it rival the sidebar for orientation.

### Verdict

Do not adopt a full tab system. Steal the **right-dock pane strip** (browser / diff / git / terminal as switchable tabs on the right of one thread) and the **drag-to-split overlay as an opt-in compare mode** only. The sidebar stays the primary navigation and the source of the one-second glance.

---

## 4. UX & interaction `design`

### Steal

- **`$skill` sigil in the composer.** `composer-logic.ts`, `composer-editor-mentions.ts`: `$claude:plan` inline tokens parsed alongside `@path` mentions and `/slash` commands into typed segments. Colon-namespacing is already cross-provider. A clean extension of Mcode's existing trigger grammar.
- **Modifier-held jump hints.** `keybindings.ts` (`shouldShowThreadJumpHintsForModifiers`): holding Cmd overlays the 1..9 jump index on threads before the digit is pressed. Mcode has Cmd+1..9 switching but no glanceable hint - pure read-path, zero keystroke cost.
- **Keybinding `when`-clause AST.** `keybindings.ts`: shortcut conditions parsed to a small `identifier | not | and | or` AST evaluated against a flat boolean context. Centralizes context-sensitive shortcuts instead of imperative per-component guards.
- **Filesystem browser inside the command palette.** `CommandPalette.tsx` + `.logic.ts`: "Add project" opens a `~/`-rooted debounced `filesystem.browse` with prefetch and `..` navigation, instead of an OS folder picker. Smoother for keyboard-first users.
- **`>` prefix = actions-only filter** in the palette (VS Code muscle memory). One regex, no separate mode.
- **Context-window radial meter.** `ContextWindowMeter.tsx`: small SVG ring in the composer footer, hover popover with used / max / total-processed tokens, no charting dep. Mcode tracks the context window already - this is the glanceable surface for it.
- **Terminal-context chips with expiry.** `ComposerPendingTerminalContexts.tsx`, `TerminalContextInlineChip.tsx`: captured terminal output as named chips with an `isTerminalContextExpired` state, not raw text.

### Skip / already-have

- Their command-palette store is minimal; Mcode's is richer.
- Empty-state copy ("Pick a thread to continue...") is warmer than Mcode's quiet/technical register. Keep Mcode's voice.
- Proposed-plan inline card - Mcode's Plan/Build toggle lives at the composer, a different composition.

### Notable

- Debounced (300ms) draft persistence with an explicit `flush()` on `beforeunload` (`composerDraftStore.ts`) - no data loss on fast close without hammering storage.
- View-stack palette navigation: submenus push onto a stack, empty-query `Backspace` pops, back-button in the input addon (`CommandPalette.tsx`).
- `useDeferredValue` on the palette query keeps input responsive while large lists filter in a low-priority pass.

---

## 5. Zed: the diff screen `design`

Zed is Rust on GPUI - none of this is copyable. These are UX, layout, and algorithm patterns to re-implement in Mcode's React diff panel. Mcode's diff reviews an agent's per-turn output, so all of Zed's git-staging / commit / branch-compare / conflict / history machinery is out of scope. What is in scope is how Zed makes a multi-file diff feel continuous and how it renders and streams diffs fast. Crate files are under `crates/`.

### Steal - diff screen UX

- **One scrollable surface, file headers inline.** `git_ui/src/project_diff.rs`, `git_ui/src/multi_diff_view.rs`: all changed files are stitched into a single continuous scroll with inline boundary headers and a deterministic sort (conflicts, then modified, then new), not a file-list-selects-a-viewer indirection. **For Mcode: the per-turn file tree becomes a jump index, and the right side becomes one continuous diff canvas.** Highest-value pattern here.
- **Scroll-driven bidirectional sync.** `git_ui/src/project_diff.rs` (`handle_editor_event`): moving through the diff highlights the current file in the list; no click needed. **For Mcode: an `IntersectionObserver` on file-section headers writes the active path into a shared atom.** Cheap, big cognitive-load reduction on multi-file turns.
- **Inline file-header actions.** `git_ui/src/git_panel.rs` (`render_buffer_header_controls`): per-file actions live in the header strip flush with the code, not in a separate toolbar. For Mcode: put "revert file" / "open in editor" inline in each file header.
- **Hunk navigation with disabled state.** `git_ui/src/project_diff.rs` (`ProjectDiffToolbar`): up/down hunk arrows that disable when there is one hunk; bound to go-to-next/prev. For Mcode: hunk arrows plus `J`/`K`.
- **Collapse new and deleted files by default.** `git_ui/src/project_diff.rs` (`refresh`/`fold_buffers`): the reviewer expands them explicitly. For Mcode: agent-created and deleted files start folded; edits to existing files stay open.
- **Flat vs tree file list with single-child directory compaction.** `git_ui/src/git_panel.rs` (`compact_directory_chain`): VS Code-style `foo/bar/baz` collapse. For Mcode's turn tree: flat scans faster for scattered changes, tree for feature-directory runs.
- **Optional `+N -M` diffstat per row** (`git_panel.rs`, behind a setting) and a **contextual empty state** (`project_diff.rs`): for Mcode, "Agent made no file changes this turn" beats a blank panel.

### Steal - diff model & rendering

- **Streaming diff via a 2-column rolling DP.** `streaming_diff/src/streaming_diff.rs`: text is diffed as it arrives (`push_new(chunk)`), emitting line operations per chunk in O(old-length) memory, scoring consecutive matches and penalizing deletions to prefer keeping existing text. **For Mcode: run this in a worker on each streamed agent token to show edits live, without buffering the whole file or re-running LCS from scratch.** The right algorithm for live agent-edit display.
- **Virtual row list with phantom deleted lines.** `multi_buffer/src/multi_buffer.rs` (`DiffTransform`): the rendered output is a flat sequence of `{ content | deleted, rowCount }` segments with a prefix-sum index; deleted lines are phantom segments with no DOM until expanded. **For Mcode: back the diff canvas with `@tanstack/react-virtual` over these segments to render a 50-file diff at 60fps.**
- **Background diff recompute, atomic snapshot swap.** `buffer_diff/src/buffer_diff.rs` (`update_diff`): diffing happens off the UI thread and publishes a new immutable snapshot; the frame always reads a consistent one. For Mcode: diff in the Shiki/diff worker, swap the hunk array atomically.
- **Hunks keyed by stable ranges + summary.** `buffer_diff.rs`: each hunk carries base-range, current-range, and precomputed added/removed counts, so the viewport can look up only intersecting hunks. For Mcode: a sorted hunk array keyed by base offset.
- **Word-level diff only for small hunks** (`buffer_diff.rs`, threshold ~5 lines): inline word highlights without burning CPU on big hunks.
- **Highlight per file once, composite diff as a separate layer.** `multi_buffer.rs` (chunk iteration): syntax highlight comes from the per-file pass; diff background/gutter is overlaid on top, not re-run per diff update. **This matches Mcode's existing Shiki worker - keep one highlight cache per file and decorate diffs over it.**

### Skip / does not map

Git staging (per-file/hunk checkboxes, stage/unstage/StageAndNext), the commit editor and AI commit message, `DiffBase`/branch-compare, conflict sections, the history tab, and "send review to agent" wiring - all tied to a git index Mcode's turn-diff does not have. Also skip the Rust internals: `SumTree`, `Anchor`/vector-clock versioning (Mcode diffs are per-turn snapshots, raw offsets suffice), and the GPUI actor model (use Web Workers).

### Signature

The continuous single-scroll diff with scroll-driven file highlighting is the diff-screen idea most worth stealing; the streaming 2-column DP and the phantom-deleted-line virtual list are the two rendering ideas that make it fast.

---

## Top picks (if only a handful land)

1. **React Compiler** - largest perf lever, deletes manual memoization. `infra`
2. **Virtualized message list** (`@legendapp/list` or equivalent) - hits the load and 60fps targets. `infra`
3. **Zed's continuous single-scroll diff** - all files in one scroll, file tree becomes a jump index, scroll-driven highlight. The diff-panel redesign. `design`
4. **Zed's streaming 2-column DP diff** - show agent edits live in a worker; phantom-deleted-line virtual list renders big diffs at 60fps. `infra`
5. **Right-dock pane strip** - the one tab pattern that fits the sidebar model. `design`
6. **`ProviderAdapterShape`** - standardize the provider contract surface. `infra`
7. **Modifier-held jump hints + `$skill` sigil** - cheap, on-brand keyboard-first wins. `design`
