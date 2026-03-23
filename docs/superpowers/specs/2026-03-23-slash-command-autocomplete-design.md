# Slash Command Autocomplete

**Issue:** #17
**Date:** 2026-03-23
**Status:** Approved

## Problem

Users must know slash command names by heart. There is no in-app discovery for Claude SDK skills or mcode built-in commands.

## Solution

Add a floating autocomplete popup to the composer. It triggers when the user types `/`, shows filtered commands from two namespaces, and lets the user select with keyboard or click.

## Approach

**Hook + popup component (Option A).** All autocomplete logic lives in a `useSlashCommand` hook. A `SlashCommandPopup` component renders the dropdown. The Composer mounts the popup and passes hook outputs to it. This keeps Composer.tsx focused and makes the hook independently testable.

## File Structure

```
apps/
├── desktop/src/main/
│   └── index.ts                   # + list-skills IPC handler
└── web/src/
    ├── transport/
    │   ├── types.ts               # + listSkills(): Promise<string[]>
    │   ├── electron.ts            # + IPC call implementation
    │   └── index.ts               # + mock (returns [])
    └── components/chat/
        ├── useSlashCommand.ts     # NEW: trigger detection, filter, keyboard nav, cache
        ├── SlashCommandPopup.tsx  # NEW: dropdown UI
        └── Composer.tsx           # MODIFIED: wire up hook + popup
```

## Data Flow

### Skill Discovery (IPC)

Main process adds a `list-skills` handler. On invocation, it scans `~/.claude/skills/*.md` and returns the filenames without the `.md` extension as `string[]`. No file contents are read -- the name is the command.

The hook caches the result in a `useRef` after first load. The IPC call fires once per component mount (lazy, on first `/` keystroke). Cache is never invalidated while the Composer is mounted.

### Mcode Command Registry

A static array in `useSlashCommand.ts`:

```ts
const MCODE_COMMANDS: Command[] = [
  {
    name: "m:plan",
    description: "Switch to plan mode",
    namespace: "mcode",
    action: "toggle-plan",
  },
];
```

Adding a new command is one array entry. The `action` field carries a side-effect identifier for commands that mutate composer state rather than just inserting text.

### Trigger Detection

On every `onChange`, the hook checks the text from the start of the input up to the cursor position. The regex `/(^|\s)(\/\S*)$/` matches `/` at the start of a line or after whitespace. The second capture group is the filter string (e.g. `"/pla"`).

No match = popup closes immediately. Match = popup opens with the filter string applied.

### Filtering

Substring `includes()` match on command name. A 50ms debounce delays filter state updates -- not trigger detection itself, which is instant.

## Component Design

### `useSlashCommand` Hook

```ts
interface UseSlashCommandReturn {
  isOpen: boolean;
  items: Command[];          // filtered list
  selectedIndex: number;     // highlighted row
  anchorRect: DOMRect | null; // for popup positioning
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (cmd: Command) => void;
  onDismiss: () => void;
}
```

The hook intercepts `keydown` before the textarea processes it:

- `ArrowUp` / `ArrowDown`: move `selectedIndex`, stop propagation
- `Enter` / `Tab`: select highlighted command, stop propagation
- `Escape`: dismiss, stop propagation
- All other keys: pass through

**Selection behaviour:**

1. The hook locates the trigger text in the textarea value (the `/` + typed filter).
2. It replaces that span with the full command string (e.g. `/m:plan`).
3. If the command has an `action`, the hook calls `onMcodeCommand(action)` -- a callback passed in by Composer.
4. Popup closes.

The hook does not know about plan mode or any other Composer internals. It delegates side-effects outward.

### `SlashCommandPopup` Component

Floating `div` positioned absolute relative to the textarea container. Uses `anchorRect` to place itself above the cursor with a 4px gap, flipping below if viewport space is insufficient.

Shows up to 8 items at once. Virtual scrolling renders only visible rows -- DOM size stays constant regardless of skill count.

**Item row layout:**

```
[icon]  commit           /commit        [skill]
[icon]  plan             /m:plan        [mcode]
```

- Name: `font-medium text-sm text-foreground`
- Description: `text-xs text-muted-foreground`
- `skill` badge: `bg-muted text-muted-foreground`
- `mcode` badge: `bg-primary/15 text-primary`

**Loading state:** skeleton shimmer on first load only (single IPC call).

**Empty state:** "No commands match" in `text-muted-foreground`, no icon.

### Composer Integration

```tsx
const {
  isOpen, items, selectedIndex, anchorRect,
  onKeyDown, onSelect, onDismiss,
} = useSlashCommand({
  textareaRef,
  onMcodeCommand: (action) => {
    if (action === "toggle-plan") {
      const next = INTERACTION_MODES.PLAN;
      setMode(next);
      if (threadId) setThreadSettings(threadId, { interactionMode: next });
    }
  },
});
```

The textarea's `onKeyDown` handler calls `autocomplete.onKeyDown` first, then runs its own logic. The existing `Enter` (send message) and `Shift+Enter` (newline) behaviour is unaffected when the popup is closed.

## Visual Design

### Entry / Exit

- Open: `opacity: 0 → 1` + `scale(0.95) → scale(1)` in 120ms, `transform-origin: bottom center`
- Close: instant (no exit animation delay)
- CSS transition only, no JS animation library needed

### Colors (existing design tokens)

| Element | Token |
|---------|-------|
| Popup background | `bg-card` |
| Popup border | `border-border` |
| Selected row | `bg-accent` |
| Mcode badge | `bg-primary/15 text-primary` |
| Skill badge | `bg-muted text-muted-foreground` |
| Shadow | `shadow-lg` |

### Keyboard Focus

Selected row gets a left border accent (`border-l-2 border-primary`) in addition to `bg-accent` so it's legible at a glance without relying on color alone.

## Testing

| Test | Type | What to cover |
|------|------|---------------|
| Trigger detection regex | Unit | `/` at line start, after whitespace, mid-word (no trigger) |
| Filter logic | Unit | Substring match, case-insensitive, empty filter shows all |
| Keyboard navigation | Unit | Arrow keys wrap, Enter selects, Escape dismisses |
| Selection + text replacement | Unit | Trigger span replaced correctly |
| Mcode side-effect dispatch | Unit | `onMcodeCommand` called with correct action |
| IPC cache | Unit | `list-skills` called once, not on second open |
| Popup positioning | Component | Flips above/below based on viewport rect |
| list-skills handler | Integration | Scans `~/.claude/skills/`, returns correct names |
