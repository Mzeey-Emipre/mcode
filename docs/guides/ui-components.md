# UI Component Registry

All UI primitives live in `apps/web/src/components/ui/`. **Always use these instead of raw HTML elements with custom Tailwind.** If a component does not exist for your use case, create it in `components/ui/` with proper variants so it can be reused, then use it.

## Available Components

| Component | File | Use Instead Of |
|-----------|------|----------------|
| `Button` | `button.tsx` | `<button className="...">` |
| `Input` | `input.tsx` | `<input className="...">` |
| `Badge` | `badge.tsx` | `<span className="rounded px-1.5 py-0.5 text-xs ...">` |
| `Dialog` | `dialog.tsx` | Custom modal divs |
| `DropdownMenu` | `dropdown-menu.tsx` | Custom dropdown implementations |
| `Command` | `command.tsx` | Custom search/autocomplete inputs |
| `ContextMenu` | `context-menu.tsx` | Custom right-click menus |
| `Popover` | `popover.tsx` | Custom floating panels |
| `ScrollArea` | `scroll-area.tsx` | `<div className="overflow-auto">` |
| `Separator` | `separator.tsx` | `<hr>` or `<div className="border-b">` |
| `Switch` | `switch.tsx` | Custom toggle implementations |
| `Tooltip` | `tooltip.tsx` | `title` attributes or custom hover text |

## Button Variants

```tsx
// Variants: default, outline, secondary, ghost, destructive, link
// Text sizes: xs/sm/default = small (h-8, text-sm), md = medium (h-12, text-base), lg = large (h-14, text-lg)
// Icon-only sizes: icon-xs/icon-sm/icon = small (size-8), icon-md = medium (size-12), icon-lg = large (size-14)
<Button variant="ghost" size="sm">Click me</Button>
<Button variant="outline" size="icon-xs"><Icon /></Button>
```

## Input Sizes

```tsx
// Sizes: xs/sm/default = small (h-8, text-sm), md = medium (h-12, text-base), lg = large (h-14, text-lg)
<Input placeholder="Default input" />
<Input size="sm" placeholder="Compact search input" />
<Input size="md" placeholder="Dialog input" />
```

## Badge Variants

```tsx
// Variants: default, secondary, destructive, outline, ghost, link
// Sizes: default (h-5, text-xs, px-2), sm (h-4, text-xs, px-1)
// Badge is a passive-label exception: compact caption sizing is allowed here, not for interactive controls.
<Badge variant="secondary">Status</Badge>
<Badge variant="secondary" size="sm">Tag</Badge>
```

## Rules

1. **Never use raw `<button>` with Tailwind classes.** Use `<Button>` with the appropriate variant and size.
2. **Never use raw `<input>` with Tailwind classes.** Use `<Input>` with the appropriate size.
3. **Never use styled `<span>` for status labels or counts.** Use `<Badge>` with the appropriate variant and size.
4. **If no existing component fits**, create a new one in `components/ui/` with CVA variants following the existing pattern. Then use it wherever needed.
5. **Stick to the documented Tailwind text scale** (`text-xs` through `text-5xl`). Do not use arbitrary values like `text-[10px]` or `text-[11px]` unless the value is an audited exception.

## Testing UI Changes

Vitest and Testing Library protect component behavior and store logic. State, layout, and visual regressions also need live inspection because they depend on the running browser or Electron renderer.

### Focused test scope

Start with focused Vitest or Testing Library coverage when you touch:

- **Interactive chat/sidebar components:** `Composer.tsx`, `MessageList.tsx`, `HeaderActions.tsx`, `RightPanel*`, `ProjectTree.tsx`, `ChatView.tsx`, `DiffToolbar.tsx`.
- **Responsive layout:** anything that flips behaviour at a breakpoint or on container width, including consumers of `useElementWidth` / `useMediaQuery`, popover-vs-inline switches, and CSS `md:` / `lg:` branches.
- **Accessibility semantics:** `role`, `aria-*`, focus traps, `dialog` wiring, keyboard shortcuts, command-registry entries.
- **Theme or token surfaces:** `index.css`, OKLCH token values, `--page` / `--background` / font-stack changes.
- **Floating panels, overlays, modals:** anything that renders into a portal or depends on z-index stacking.
- **State persistence that affects first paint:** localStorage-backed state like thread-list expansion, sidebar width, panel visibility.

### When live UI verification can be skipped

- Pure type or contract refactors with no DOM change.
- Server-only edits (`apps/server/**`) that the web layer doesn't surface in the current change set.
- Store or reducer logic with no rendered behavior change.
- Comment-, docstring-, or doc-only edits.
- Backend-only test additions.

### Minimum check

Add or update the nearest focused test. Run it.

Use `$electorn-live-testing` when the user requests live proof or the focused
test cannot cover an Electron-only boundary. Check the exact state, interaction,
accessibility data, console output, and viewport. Store temporary scripts under
`.dev/playwright-scratch` and evidence under `.dev/verification/`.
