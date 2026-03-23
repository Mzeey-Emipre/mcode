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
    │   ├── tauri.ts               # + listSkills stub (throws / returns [])
    │   └── index.ts               # + listSkills stub in createMockTransport()
    └── components/chat/
        ├── useSlashCommand.ts     # NEW: trigger detection, filter, keyboard nav, cache
        ├── SlashCommandPopup.tsx  # NEW: dropdown UI
        └── Composer.tsx           # MODIFIED: wire up hook + popup
```

## Data Flow

### Skill Discovery (IPC)

Main process adds a `list-skills` handler. Skills are stored as directories under `~/.claude/skills/` (e.g. `~/.claude/skills/commit/`, `~/.claude/skills/review-pr/`). The handler calls `readdirSync(skillsDir, { withFileTypes: true })`, filters for directories, and returns their names as `string[]`. No file contents are read -- the directory name is the command.

All three transports implement `listSkills(): Promise<string[]>` on `McodeTransport`:

| Transport | Behaviour |
|-----------|-----------|
| `electron.ts` | IPC call to the `list-skills` handler |
| `tauri.ts` | `throw new Error("Not implemented in Tauri")` (matches Tauri stub pattern) |
| `createMockTransport()` in `index.ts` | `return []` (matches mock silent-degradation pattern used by `listBranches`, `listWorktrees`) |

The hook caches the result in a `useRef` after first load. The IPC call fires once per session (lazy, on first `/` keystroke). The cache has a 5-minute TTL: if the user triggers autocomplete and 5 minutes have elapsed since the last fetch, the hook re-fetches in the background and updates the list. This lets users install a new skill mid-session and see it without restarting.

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

Case-insensitive substring match: `name.toLowerCase().includes(filter.toLowerCase())`. No debounce -- filtering over ~80 strings is sub-millisecond and debouncing creates visible lag with no benefit.

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

`anchorRect` is recomputed on every `onChange` while the popup is open (not just at trigger time). This keeps the popup anchored correctly as the textarea resizes with additional lines.

Shows up to 8 items at once. `@tanstack/react-virtual` (already a dependency via `MessageList`) handles virtual scrolling if the list exceeds 20 items; below that threshold, render all rows directly to avoid the overhead.

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

**Empty state:** A single row with an empty icon placeholder (same width as the icon column) and "No commands match" in `text-muted-foreground`. The placeholder keeps alignment consistent with populated rows.

### Composer Integration

```tsx
const {
  isOpen, items, selectedIndex, anchorRect,
  onKeyDown, onSelect, onDismiss,
} = useSlashCommand({
  textareaRef,
  onMcodeCommand: (action) => {
    if (action === "toggle-plan") {
      // Toggle: if already in plan mode, switch back to chat
      const next = mode === INTERACTION_MODES.PLAN
        ? INTERACTION_MODES.CHAT
        : INTERACTION_MODES.PLAN;
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
| list-skills handler | Integration | Scans `~/.claude/skills/` subdirectories, returns directory names (not `.md` files) |
| Cache TTL | Unit | Re-fetches after 5 minutes, not before |
