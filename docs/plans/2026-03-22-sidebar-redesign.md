# Sidebar Redesign: Collapsible Project Tree

*Date: 2026-03-22*
*Status: Approved*

## Problem

The current sidebar splits workspaces and threads into two separate sections with a hard border. Clicking a project shows threads in a different panel below. This is bad UX compared to T3Code's collapsible folder pattern.

## Design

Replace the split-panel sidebar with a single unified project tree where each workspace is a collapsible folder with threads nested inline.

### Layout

```
┌──────────────────────────────────┐
│  Mcode                      [+] │
├──────────────────────────────────┤
│  PROJECTS                     + │
│                                  │
│  ▾ 📁 skillfuse architecture    │
│    ● Awaiting Input  I want...  13d│
│    ● Awaiting Input  i want...  13d│
│                                  │
│  ▾ 📁 mcode                     │
│    ● Working  implement au...   2m │
│    ✓ Completed  fix login...    1h │
│                                  │
│  ▸ 📁 re4urb                    │
│                                  │
│                                  │
│  ⚙ Settings                     │
└──────────────────────────────────┘
```

### Thread Status Labels

| Status | Label | Color | When |
|--------|-------|-------|------|
| active | Working | yellow | Agent is running |
| awaiting_input | Awaiting Input | blue | Waiting for user's next message |
| errored | Errored | red | Agent process crashed |
| completed | Completed | green | Work is done |

Internal states `interrupted` and `archived` map to "Awaiting Input" in the UI since the user needs to take action.

### Key Behaviors

- Projects are collapsible tree nodes (chevron ▸/▾)
- Threads nested inside their parent project
- Expand/collapse state persisted in localStorage
- Thread row shows: status dot, status label, truncated title, relative timestamp
- "Settings" at bottom shows text + icon (not just icon)
- "+" button at top opens folder picker

### Components

- Delete `WorkspaceList.tsx` and `ThreadList.tsx`
- Create `ProjectTree.tsx` (unified replacement)
- Update `Sidebar.tsx` to use ProjectTree
- Update `SettingsDialog.tsx` to show "Settings" text
- Update `ThreadStatus` enum to include `awaiting_input`
