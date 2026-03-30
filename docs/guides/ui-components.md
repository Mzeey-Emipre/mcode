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
