# Worktree/Branch Picker Feature Plan

## Phases (Agent Team Execution)

### Phase 1-2: Backend (1 agent, sequential)
- Add `listBranches()` and `getCurrentBranch()` to worktree.ts
- Add `listBranches()` to AppState
- Update `createAndSendMessage()` to accept mode/branch params
- Register `list-branches` IPC handler
- Update `create-and-send-message` IPC handler

### Phase 3: Transport (1 agent)
- Add `GitBranch` type, extend `McodeTransport`
- Wire electron.ts, stub tauri.ts and mock transport

### Phase 4: Store (1 agent)
- Add branches state, newThreadMode, newThreadBranch to workspaceStore
- Update createAndSendMessage to pass mode/branch

### Phase 5: UI Components (3 agents: 2 parallel + 1 sequential)
- Agent A: ModeSelector.tsx (Local / New worktree dropdown)
- Agent B: BranchPicker.tsx (searchable branch dropdown with badges)
- Agent C: Composer integration (after A+B)

### Phase 6: Branch name generation (1 agent, parallel with Phase 5)
- branch-name.ts utility (heuristic kebab-case from message content)
- Wire into createAndSendMessage flow

### Phase 7-8: Deferred (v2)
- AI-generated branch names via Haiku
- Project-level branch prefix settings

## Files: 13 total (4 new, 9 modified)

See planner output for full details.
