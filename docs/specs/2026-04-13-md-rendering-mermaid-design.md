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

`stripInjectedFiles` still runs before passing content. Attachments (images, files) continue rendering above the text bubble. No changes to attachment handling.

#### Prose Overrides for the Primary Bubble

The outer user-message div has `bg-primary text-primary-foreground`. A utility class (`prose-user-bubble` or equivalent) overrides markdown element colors:

| Element | Override |
|---------|----------|
| Inline code | `bg-primary-foreground/15` (semi-transparent white) instead of `bg-muted` |
| Code blocks | `bg-black/20` background, `text-primary-foreground` text, no Shiki |
| Links | `text-primary-foreground underline`, hover opacity |
| Blockquotes | `border-primary-foreground/40` left border |
| Table borders | `border-primary-foreground/20` |
| Horizontal rules | `border-primary-foreground/20` |

### 2. MarkdownContent Changes

**New prop:** `variant?: "assistant" | "user"` (defaults to `"assistant"`).

Threaded through to the `makeComponents` factory to control code block behavior.

**Code handler fork (inside `makeComponents`):**

1. Inline code detection (unchanged)
2. `language === "plan-questions"` - return null (unchanged)
3. `language === "mermaid"` - return `<LazyMermaidBlock code={code} isStreaming={isStreaming} />`
4. Default - return `<CodeBlock code={code} language={language} isStreaming={isStreaming} disableHighlighting={variant === "user"} />`

`LazyMermaidBlock` declared at module scope via `React.lazy(() => import("./MermaidBlock"))`, wrapped in `<Suspense>` at the call site with a plain `<pre>` fallback showing the raw code.

### 3. MermaidBlock Component

**New file:** `components/chat/MermaidBlock.tsx`

```tsx
interface MermaidBlockProps {
  code: string;
  isStreaming: boolean;
}
```

#### Lazy Loading

The component itself is lazy-loaded via `React.lazy` in `MarkdownContent.tsx`. The mermaid library is loaded via dynamic `import("mermaid")` inside the component on first mount. A module-level variable caches the import promise so subsequent blocks reuse it.

#### Initialization

`mermaid.initialize()` called once with `{ startOnLoad: false, theme: "dark" | "default" }`. Theme derived from `useShikiTheme()`:

- `"github-dark"` maps to mermaid `"dark"`
- `"github-light"` maps to mermaid `"default"`

#### Theme Reactivity

When `useShikiTheme()` changes, the component re-initializes mermaid and re-renders the SVG. A ref tracks the last-applied theme to avoid redundant re-inits.

#### Rendering Flow

1. **Streaming (`isStreaming === true`):** Render raw code in a plain `<pre><code>` (same as `CodeBlock` streaming mode). No mermaid parsing.
2. **Completed (`isStreaming === false`):** Call `mermaid.render(id, code)` where `id` uses React's `useId()` for unique, SSR-safe IDs. Store the SVG string in state.
3. **SVG output:** Rendered via `dangerouslySetInnerHTML` inside a container with `overflow-x: auto`.

#### Toggle (Diagram / Code)

- State: `"diagram"` (default) | `"code"`
- Top-right corner: toggle icon button + copy button, matching `CodeBlock`'s header layout
- `"diagram"` state: SVG container. Toggle switches to code view.
- `"code"` state: `CodeBlock` with `language="mermaid"` and Shiki highlighting. Toggle switches back.
- Copy button always copies the raw mermaid source, regardless of view state.

#### Error Handling

- If `mermaid.render()` throws, catch and render `CodeBlock` with the raw source plus a small error banner: "Diagram could not be rendered"
- No toggle shown in error state
- Error stored in state; theme changes don't retry a broken diagram unless the code itself changes

#### Virtualizer Compatibility

React's `useId()` generates stable IDs per component instance. When the virtualizer unmounts/remounts a row during scroll, a new instance gets a new ID and calls `mermaid.render()` fresh. No stale DOM lookups.

### 4. CodeBlock Changes

Add a `disableHighlighting` prop. When true, skip the Shiki worker call and render the same plain `<pre><code>` used during streaming mode. The copy button and language label remain functional.

## Security

### SVG Sanitization

Mermaid SVG output is rendered via `dangerouslySetInnerHTML`. This is safe because:

1. **Mermaid v10+ bundles DOMPurify internally** and sanitizes all SVG output before returning it from `mermaid.render()`. Script tags, event handlers, and other XSS vectors are stripped.
2. The input to `mermaid.render()` is the raw mermaid DSL source - not arbitrary HTML. Mermaid parses the DSL into its own AST and generates SVG from that AST, so user-provided HTML in the source does not pass through to the output.
3. The mermaid dependency should be pinned to a version >= 10.0.0 to guarantee the built-in DOMPurify sanitization.

No additional sanitization layer is needed, but the version constraint must be enforced in `package.json`.

## Files Changed

| File | Change |
|------|--------|
| `components/chat/MessageBubble.tsx` | Replace `<p>` with `<LazyMarkdownContent>`, add prose overrides to user bubble div |
| `components/chat/MarkdownContent.tsx` | Add `variant` prop, mermaid language fork in code handler, `LazyMermaidBlock` lazy import |
| `components/chat/MermaidBlock.tsx` | **New.** SVG rendering, lazy mermaid import, diagram/code toggle, error fallback, theme reactivity |
| `components/chat/CodeBlock.tsx` | Add `disableHighlighting` prop to skip Shiki |
| `package.json` (web) | Add `mermaid` dependency (>= 10.0.0) |

## Files Unchanged

- `MessageList.tsx` - virtualization unchanged
- `StreamingCard.tsx` - streaming preview stays plain text
- Server-side - purely frontend change
- `vite.config.ts` - mermaid loaded via dynamic import at component level, not through the Shiki worker

## Bundle Impact

Mermaid is ~800KB parsed but loaded lazily on first mermaid block encounter. Zero cost for users who never see mermaid diagrams. The `MermaidBlock` chunk itself is small.

## Acceptance Criteria

- [ ] User messages render full GFM markdown (bold, italic, code blocks, tables, lists, links, headings)
- [ ] User message code blocks render as plain monospace (no Shiki) with copy button
- [ ] User message prose elements have correct contrast against the primary bubble background
- [ ] Mermaid code blocks render as SVG diagrams by default in both user and assistant messages
- [ ] Toggle button swaps between rendered diagram and syntax-highlighted source
- [ ] Invalid mermaid syntax falls back to a code block with an error hint
- [ ] Mermaid blocks show raw code during streaming, render diagram on completion
- [ ] Mermaid theme follows app dark/light mode and reacts to theme changes
- [ ] Wide diagrams scroll horizontally within the message bubble
- [ ] Mermaid dependency pinned to >= 10.0.0 for built-in DOMPurify sanitization
- [ ] No server-side changes required
