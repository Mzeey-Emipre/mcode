# Markdown Rendering for User Messages and Mermaid Diagram Visualizer

**Issue:** #256
**Date:** 2026-04-13
**Status:** Draft

## Overview

User messages render as plain text today. This spec adds GFM markdown rendering to user messages using the existing `MarkdownContent` component, and introduces a `MermaidBlock` component that renders mermaid fenced code blocks as SVG diagrams in both user and assistant messages.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| User bubble styling | Override prose element colors within the existing `bg-primary` bubble | Preserves theme identity; avoids restyling the bubble |
| Shiki in user bubbles | Disabled - plain monospace code blocks | Shiki token colors assume neutral backgrounds; forced onto a primary-colored bubble they produce inconsistent contrast. Users rarely paste long code in their own messages. |
| Mermaid rendering | Single `MermaidBlock` component with lazy-loaded `mermaid` library | Lowest complexity, full control over toggle/streaming/errors. Worker approach is overkill (mermaid needs DOM access). Plugin approach (`rehype-mermaid`) sacrifices toggle and streaming control. |
| Oversized diagrams | Horizontal scroll (`overflow-x: auto`) | Contained and predictable. Scale-to-fit makes text unreadable on complex diagrams. Expanding beyond the bubble breaks layout. |

## Architecture

### 1. User Message Markdown

In `MessageBubble.tsx`, replace the plain `<p>` rendering of user messages with the existing `LazyMarkdownContent` component (already lazy-imported in the file).

```tsx
// Before
<p className="whitespace-pre-wrap break-words">{textContent}</p>

// After
<Suspense>
  <LazyMarkdownContent content={textContent} isStreaming={false} variant="user" />
</Suspense>
```

`isStreaming` is hardcoded to `false` because user messages are always complete - they are never streamed from a provider.

`stripInjectedFiles` still runs before passing content. Attachments (images, files) continue rendering above the text bubble. No changes to attachment handling.

#### Prose Overrides for the Primary Bubble

The outer user-message div has `bg-primary text-primary-foreground`. Overrides are applied in two layers:

1. **`MarkdownContent` variant-aware `staticComponents`:** When `variant === "user"`, the `makeComponents` factory returns alternate class names for elements that hardcode `bg-muted` or other neutral-background colors. This handles inline code, blockquote borders, table borders, and horizontal rules.
2. **Code block overrides:** The `disableHighlighting` prop on `CodeBlock` triggers its plain-mode render path, which already uses neutral styling. The user-bubble wrapper's `text-primary-foreground` inherits down to the code text.

Override targets:

| Element | Default (assistant) | User bubble override |
|---------|---------------------|----------------------|
| Inline code | `bg-muted rounded px-1.5 py-0.5` | `bg-primary-foreground/15 rounded px-1.5 py-0.5` |
| Code blocks | Shiki-highlighted with `bg-muted/30` | Plain monospace with `bg-black/20`, `text-primary-foreground` |
| Links | `text-primary hover:underline` | `text-primary-foreground underline hover:opacity-80` |
| Blockquotes | `border-border` left border | `border-primary-foreground/40` left border |
| Table borders | `border-border` | `border-primary-foreground/20` |
| Horizontal rules | `border-border` | `border-primary-foreground/20` |

### 2. MarkdownContent Changes

**New prop:** `variant?: "assistant" | "user"` (defaults to `"assistant"`).

**`makeComponents` signature change:** From `makeComponents(isStreaming: boolean)` to `makeComponents(isStreaming: boolean, variant: "assistant" | "user")`. The `useMemo` dependency array updates from `[isStreaming]` to `[isStreaming, variant]`.

**Code handler fork (inside `makeComponents`):**

1. Inline code detection (unchanged)
2. `language === "plan-questions"` - return null (unchanged)
3. `language === "mermaid"`:

```tsx
<Suspense fallback={<pre className="bg-muted/30 rounded-lg p-4 overflow-x-auto"><code>{code}</code></pre>}>
  <LazyMermaidBlock code={code} isStreaming={isStreaming} />
</Suspense>
```

4. Default - return `<CodeBlock code={code} language={language} isStreaming={isStreaming} disableHighlighting={variant === "user"} />`

`LazyMermaidBlock` declared at module scope:

```tsx
const LazyMermaidBlock = React.lazy(() => import("./MermaidBlock"));
```

### 3. MermaidBlock Component

**New file:** `components/chat/MermaidBlock.tsx`

```tsx
interface MermaidBlockProps {
  code: string;
  isStreaming: boolean;
}
```

#### Lazy Loading

The component itself is lazy-loaded via `React.lazy` in `MarkdownContent.tsx`. The mermaid library is loaded via dynamic `import("mermaid")` inside the component on first mount. A module-level variable caches the import promise so subsequent blocks reuse it:

```tsx
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid");
  }
  return mermaidPromise;
}
```

#### Initialization

`mermaid.initialize()` is called from a module-level helper that runs after the dynamic import resolves. It uses `{ startOnLoad: false, securityLevel: "strict", theme: "dark" | "default" }`. The helper is idempotent - a module-level variable tracks the last theme passed to `initialize()`.

When multiple `MermaidBlock` instances exist on the same page, they all call `loadMermaid()` which returns the same cached promise. Only the first resolution triggers `initialize()`. Subsequent instances skip straight to `render()`.

Theme derived from `useShikiTheme()`:

- `"github-dark"` maps to mermaid `"dark"`
- `"github-light"` maps to mermaid `"default"`

#### Theme Reactivity

When `useShikiTheme()` changes, any mounted `MermaidBlock` detects the mismatch between the module-level last-initialized theme and the current theme. It updates the module-level theme variable synchronously (before any async work), then re-calls `mermaid.initialize()` with the new theme and re-renders the SVG. Because the variable is written synchronously on detection, other blocks in the same render cycle see the updated value and skip re-initialization. `mermaid.initialize()` is idempotent, so concurrent calls with the same theme are harmless.

#### Rendering Flow

The component manages three states: `loading`, `success`, and `error`.

1. **Streaming (`isStreaming === true`):** Render raw code in a plain `<pre><code>` (same as `CodeBlock` streaming mode). No mermaid parsing. State machine is not entered.
2. **Completed (`isStreaming === false`):** A `useEffect` calls `loadMermaid()`, then `await mermaid.render(id, code)`. The call is async and returns `Promise<{ svg: string }>`. The SVG string is stored in state on success, or the error is stored on failure.
3. **SVG output:** Rendered via `dangerouslySetInnerHTML` inside a container with `overflow-x: auto`. This is safe because mermaid v10+ sanitizes SVG output with its bundled DOMPurify before returning it (see Security section).

**Race condition handling:** The `useEffect` uses a `cancelled` boolean checked before setting state. If the theme changes while a `render()` call is in flight, the stale result is discarded and a new render is triggered.

**ID generation:** `useId()` returns IDs with colons (e.g., `:r0:`) which are invalid in CSS selectors. The ID is sanitized: `"mermaid-" + useId().replace(/:/g, "")`, producing IDs like `mermaid-r0` that start with a letter and contain no special characters.

**Empty/whitespace blocks:** If `code.trim()` is empty, render nothing (return `null`). No error banner, no code block - an empty mermaid fence is a no-op.

#### Toggle (Diagram / Code)

- State: `"diagram"` (default) | `"code"`
- Top-right corner: `Code2` icon (Lucide) to switch to code view, `GitGraph` icon to switch back to diagram view, plus a copy button. Layout matches `CodeBlock`'s header bar pattern.
- `"diagram"` state: SVG container. Toggle switches to code view.
- `"code"` state: `CodeBlock` with `language="mermaid"`. No Shiki grammar exists for mermaid in `@shikijs/langs` v4.0.2, so the code view renders as plain monospace text with the language label "mermaid". Toggle switches back.
- Copy button always copies the raw mermaid source, regardless of view state.

#### Error Handling

- If `mermaid.render()` rejects, catch and render `CodeBlock` with the raw source plus a small error banner above the code: "Diagram could not be rendered"
- No toggle shown in error state (nothing to toggle to)
- Error stored in state; theme changes don't retry a broken diagram unless the `code` prop changes (tracked via `useEffect` dependency on `code`)

#### Virtualizer Compatibility

The sanitized `useId()` generates stable IDs per component instance. When the virtualizer unmounts/remounts a row during scroll, a new instance gets a new ID and calls `mermaid.render()` fresh. No stale DOM lookups.

### 4. CodeBlock Changes

Add a `disableHighlighting?: boolean` prop (defaults to `false`). When true, pass `enabled: false` to the `useHighlighter` hook and render the same plain `<pre><code>` path used during streaming mode. The copy button and language label remain functional.

## Security

### SVG Sanitization

Mermaid SVG output is rendered via `dangerouslySetInnerHTML`. This is safe because:

1. **Mermaid v10+ bundles DOMPurify internally** and sanitizes all SVG output before returning it from `mermaid.render()`. Script tags, event handlers, and other XSS vectors are stripped.
2. The input to `mermaid.render()` is the raw mermaid DSL source - not arbitrary HTML. Mermaid parses the DSL into its own AST and generates SVG from that AST, so user-provided HTML in the source does not pass through to the output.
3. The mermaid dependency is pinned to `>= 10.0.0` in `package.json` to guarantee the built-in DOMPurify sanitization.
4. `securityLevel: "strict"` is set in `mermaid.initialize()`, which disables click event handlers and external URI access in rendered diagrams.

No additional sanitization layer is needed, but the version constraint and security level must be enforced.

## Files Changed

| File | Change |
|------|--------|
| `components/chat/MessageBubble.tsx` | Replace `<p>` with `<LazyMarkdownContent>`, user bubble prose overrides inherited via variant |
| `components/chat/MarkdownContent.tsx` | Add `variant` prop, update `makeComponents(isStreaming, variant)` signature and `useMemo` deps, mermaid language fork in code handler, `LazyMermaidBlock` lazy import, variant-aware `staticComponents` for user bubble colors |
| `components/chat/MermaidBlock.tsx` | **New.** SVG rendering, lazy mermaid import, diagram/code toggle, error fallback, theme reactivity |
| `components/chat/CodeBlock.tsx` | Add `disableHighlighting` prop to skip Shiki |
| `package.json` (web) | Add `mermaid` dependency (`>= 10.0.0`) |
| `vite.config.ts` (web) | Add `mermaid` to `optimizeDeps.exclude` so Vite skips pre-bundling the large package and its internal dynamic imports |

## Files Unchanged

- `MessageList.tsx` - virtualization unchanged
- `StreamingCard.tsx` - streaming preview stays plain text
- Server-side - purely frontend change

## Bundle Impact

Mermaid is ~800KB parsed but loaded lazily on first mermaid block encounter. Zero cost for users who never see mermaid diagrams. The `MermaidBlock` chunk itself is small. Adding `mermaid` to `optimizeDeps.exclude` avoids Vite pre-bundling overhead during development.

## Acceptance Criteria

- [ ] User messages render full GFM markdown (bold, italic, code blocks, tables, lists, links, headings)
- [ ] User message code blocks render as plain monospace (no Shiki) with copy button
- [ ] User message prose elements have correct contrast against the primary bubble background
- [ ] Mermaid code blocks render as SVG diagrams by default in both user and assistant messages
- [ ] Toggle button swaps between rendered diagram and syntax-highlighted source
- [ ] Invalid mermaid syntax falls back to a code block with an error hint
- [ ] Empty mermaid blocks render nothing (no error, no empty diagram)
- [ ] Mermaid blocks show raw code during streaming, render diagram on completion
- [ ] Mermaid theme follows app dark/light mode and reacts to theme changes
- [ ] Wide diagrams scroll horizontally within the message bubble
- [ ] Mermaid dependency pinned to >= 10.0.0 for built-in DOMPurify sanitization
- [ ] `securityLevel: "strict"` set in mermaid initialization
- [ ] Mermaid code view in toggle shows plain text (no Shiki grammar available)
- [ ] No server-side changes required
