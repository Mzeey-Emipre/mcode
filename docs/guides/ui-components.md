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
// Sizes: default (h-8), xs (h-6), sm (h-7), lg (h-9), icon (8x8), icon-xs (6x6), icon-sm (7x7), icon-lg (9x9)
<Button variant="ghost" size="sm">Click me</Button>
<Button variant="outline" size="icon-xs"><Icon /></Button>
```

## Input Sizes

```tsx
// Sizes: default (h-8), sm (h-7), xs (h-6)
<Input placeholder="Default input" />
<Input size="sm" placeholder="Compact search input" />
<Input size="xs" placeholder="Inline edit input" />
```

## Badge Variants

```tsx
// Variants: default, secondary, destructive, outline, ghost, link
// Sizes: default (h-5), sm (h-4)
<Badge variant="secondary">Status</Badge>
<Badge variant="secondary" size="sm">Tag</Badge>
```

## Rules

1. **Never use raw `<button>` with Tailwind classes.** Use `<Button>` with the appropriate variant and size.
2. **Never use raw `<input>` with Tailwind classes.** Use `<Input>` with the appropriate size.
3. **Never use styled `<span>` for status labels or counts.** Use `<Badge>` with the appropriate variant and size.
4. **If no existing component fits**, create a new one in `components/ui/` with CVA variants following the existing pattern. Then use it wherever needed.
5. **Stick to the Tailwind text scale** (`text-xs`, `text-sm`, `text-base`). Do not use arbitrary values like `text-[10px]` or `text-[11px]`.

## Testing UI Changes

Vitest covers rendering and store logic, but a lot of frontend regressions are state- or layout-driven and only show up when the browser actually lays the page out. Run Playwright against your change when any of the triggers below apply.

### When to run Playwright

Run `cd apps/web && bun run e2e` (or target a single spec with `bunx playwright test <file>`) before claiming the change is done when you touch:

- **Interactive chat/sidebar components:** `Composer.tsx`, `MessageList.tsx`, `HeaderActions.tsx`, `RightPanel*`, `ProjectTree.tsx`, `ChatView.tsx`, `DiffToolbar.tsx`.
- **Responsive layout:** anything that flips behaviour at a breakpoint or on container width, including consumers of `useElementWidth` / `useMediaQuery`, popover-vs-inline switches, and CSS `md:` / `lg:` branches.
- **Accessibility semantics:** `role`, `aria-*`, focus traps, `dialog` wiring, keyboard shortcuts, command-registry entries.
- **Theme or token surfaces:** `index.css`, OKLCH token values, `--page` / `--background` / font-stack changes. E2E has token-identity assertions that catch accidental overrides.
- **Test hooks:** new or renamed `data-testid` attributes, or any rename that could break selectors.
- **Floating panels, overlays, modals:** anything that renders into a portal or depends on z-index stacking.
- **State persistence that affects first paint:** localStorage-backed state like thread-list expansion, sidebar width, panel visibility.

### When you can skip Playwright

- Pure type or contract refactors with no DOM change.
- Server-only edits (`apps/server/**`) that the web layer doesn't surface in the current change set.
- Store/reducer logic already covered by Vitest.
- Comment-, docstring-, or doc-only edits.
- Backend-only test additions.

### Minimum bar

For every change that matches a trigger, run at least the specs that touch the components you modified, plus `ui-improvements-floating.spec.ts` if layout or tokens moved. Report the pass count in the PR — "N/N of touched specs pass; unrelated pre-existing failures out of scope" is the expected shape. Do not claim success without fresh output.
