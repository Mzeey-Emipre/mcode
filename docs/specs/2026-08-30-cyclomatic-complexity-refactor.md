# Cyclomatic Complexity Refactoring Specification

**Date:** 2026-08-30

**Status:** Ready for Agent

## Problem Statement

The codebase contains functions with high cyclomatic complexity (ranging up to 343 independent execution paths in core message routing and state management). High cyclomatic complexity creates bloated functions, makes code hard to test thoroughly, and increases the likelihood of regressions when AI agents or developers modify logic across nested branches.

## Solution

Enforce a maximum cyclomatic complexity threshold of 10 across the repository using Oxlint as a warning during active development and PR gates. Progressively refactor the identified violating functions into modular helper functions, strategy maps, and domain reducers without altering external behavior, APIs, or component contracts.

## User Stories

1. As a developer, I want functions to have a cyclomatic complexity of 10 or less so that each function is focused, easy to understand, and maintainable.
2. As an engineer writing tests, I want low-complexity functions so that I can achieve high branch coverage with minimal test fixture combinatorial explosion.
3. As a contributor modifying routing logic, I want isolated handler lookup tables instead of monolithic switch blocks so that adding new message types does not risk breaking existing routes.
4. As an engineer working with AI agents, I want complexity warnings to prevent the introduction of new large routines.
5. As a frontend developer, I want React components to delegate nested conditional UI logic into dedicated subcomponents.
6. As a backend developer, I want provider adapters to separate protocol normalization, process management, and event handling into separate classes.

## Implementation Decisions

- Configure Oxlint with `"complexity": ["warn", { "max": 10 }]` and `"max-depth": ["warn", 4]` in `.oxlintrc.json`.
- Use strategy maps and dispatch dictionaries for large `switch` statements (e.g. in `ws-router.ts`).
- Split complex React components (`PreviewPanel`, `MessageBubble`, `DiffPanel`) into composable subcomponents and focused custom hooks.
- Keep all public APIs, IPC interfaces, WebSocket message shapes, and store schemas strictly backward-compatible.
- Refactor functions incrementally per workspace in dedicated, reviewable pull requests.

## Testing Decisions

- Refactoring must maintain 100% test pass rate across existing test suites (`bun run test`).
- All workspace-specific suites (`apps/server`, `apps/web`, `apps/desktop`, `packages/*`) must pass without regressions.
- Verification runs via `bun run lint:fast` to confirm reduction in complexity warnings after each refactoring PR.

## Out of Scope

- Modifying user-facing UI designs, styling, or interaction behaviors.
- Altering external network protocol schemas or contract definitions.
- Changing existing runtime process architectures.

## Complete Inventory of Violating Files (Complexity > 10)

A total of **373 files** contain functions exceeding the cyclomatic complexity threshold of 10.

### apps/web (180 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `apps/web/src/stores/threadStore.ts` | **218** | 22 |
| `apps/web/src/features/preview/surfaces/PreviewPanel.tsx` | **118** | 6 |
| `apps/web/src/features/subagents/roster/subagent-projection.ts` | **101** | 1 |
| `apps/web/src/features/preview/automation/BrowserAutomationHost.tsx` | **80** | 14 |
| `apps/web/src/features/conversation/messages/MessageBubble.tsx` | **78** | 3 |
| `apps/web/src/features/conversation/messages/virtual-items.ts` | **66** | 5 |
| `apps/web/src/components/panels/RightPanel.tsx` | **64** | 3 |
| `apps/web/src/features/conversation/messages/ChatView.tsx` | **63** | 1 |
| `apps/web/src/features/preview/automation/services/browserSessionDriver.ts` | **60** | 9 |
| `apps/web/src/components/diff/DiffPanel.tsx` | **55** | 3 |
| `apps/web/src/features/projects/ProjectTree.tsx` | **55** | 6 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestDetailPane.tsx` | **50** | 4 |
| `apps/web/src/components/chat/ThreadOverview.tsx` | **49** | 5 |
| `apps/web/src/features/conversation/narrative/build-narrative.ts` | **49** | 1 |
| `apps/web/src/workers/shiki.worker.ts` | **48** | 1 |
| `apps/web/src/features/conversation/hydration/thread-hydrator.ts` | **47** | 5 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestCode.tsx` | **45** | 3 |
| `apps/web/src/features/preview/automation/browserAutomationWebExecutor.ts` | **44** | 5 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestIssueCommentComposer.tsx` | **44** | 1 |
| `apps/web/src/features/projects/environment/ProjectAutomaticSetupControl.tsx` | **43** | 2 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestSubmitReviewDialog.tsx` | **42** | 1 |
| `apps/web/src/components/chat/UsagePopover.tsx` | **40** | 1 |
| `apps/web/src/hooks/useComposerLayoutGuard.ts` | **40** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestSummary.tsx` | **40** | 2 |
| `apps/web/src/features/preview/automation/webBrowserInteractionExecutor.ts` | **38** | 5 |
| `apps/web/src/components/palette/views/BrowseView.tsx` | **37** | 1 |
| `apps/web/src/components/diff/UnifiedDiff.tsx` | **37** | 1 |
| `apps/web/src/features/conversation/narrative/build-persisted-narrative.ts` | **37** | 1 |
| `apps/web/src/features/conversation/messages/canonical-message-projection.ts` | **37** | 3 |
| `apps/web/src/features/projects/state/workspaceStore.ts` | **36** | 4 |
| `apps/web/src/features/preview/automation/web-browser-automation/capture.ts` | **36** | 7 |
| `apps/web/src/features/terminal/adapters/modern/modern-terminal-client.ts` | **34** | 2 |
| `apps/web/src/features/preview/automation/browserAutomationRecorder.ts` | **33** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestLifecycleDialog.tsx` | **33** | 2 |
| `apps/web/src/features/preview/automation/services/__tests__/browserExecutorParity.test.ts` | **33** | 2 |
| `apps/web/src/features/preview/browser-surfaces/BrowserSurfaceHost.ts` | **32** | 3 |
| `apps/web/src/features/preview/surfaces/BrowserHeader.tsx` | **32** | 1 |
| `apps/web/src/features/preview/surfaces/BrowserSurfacePresentationCoordinator.ts` | **31** | 1 |
| `apps/web/src/features/terminal/settings/TerminalSection.tsx` | **30** | 2 |
| `apps/web/src/features/conversation/hydration/record-cache.ts` | **30** | 2 |
| `apps/web/src/features/conversation/subscriptions/useThreadSubscriptionReconciler.ts` | **29** | 3 |
| `apps/web/src/components/chat/lexical/KeyboardPlugin.tsx` | **29** | 1 |
| `apps/web/src/lib/composer-session/index.ts` | **29** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestInbox.tsx` | **29** | 2 |
| `apps/web/src/lib/review-comparison.ts` | **28** | 1 |
| `apps/web/src/app/App.tsx` | **28** | 1 |
| `apps/web/src/components/palette/CommandPalette.tsx` | **28** | 2 |
| `apps/web/src/components/diff/SideBySideDiff.tsx` | **28** | 3 |
| `apps/web/src/components/chat/PlanQuestionWizard.tsx` | **27** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestReviewTaskDialog.tsx` | **27** | 3 |
| `apps/web/src/components/chat/ModelSelector.tsx` | **26** | 4 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestLifecycleActions.tsx` | **26** | 1 |
| `apps/web/src/features/pull-requests/state/pullRequestCodeStore.ts` | **26** | 6 |
| `apps/web/src/features/conversation/narrative/BrowserActivityRow.tsx` | **25** | 3 |
| `apps/web/src/components/chat/CreatePrDialog.tsx` | **24** | 1 |
| `apps/web/src/features/terminal/surfaces/TerminalView.tsx` | **24** | 1 |
| `apps/web/src/components/settings/sections/AboutSection.tsx` | **24** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestTimeline.tsx` | **24** | 3 |
| `apps/web/src/features/preview/surfaces/BrowserViewportCanvas.tsx` | **24** | 2 |
| `apps/web/src/components/settings/sections/ModelSection.tsx` | **23** | 1 |
| `apps/web/src/components/diff/FileList.tsx` | **23** | 1 |
| `apps/web/src/components/diff/FileEntry.tsx` | **23** | 1 |
| `apps/web/src/components/diff/DiffToolbar.tsx` | **23** | 2 |
| `apps/web/src/components/chat/plan-questions/useWizardKeyboard.ts` | **22** | 1 |
| `apps/web/src/features/conversation/narrative/TurnFooter.tsx` | **22** | 1 |
| `apps/web/src/features/conversation/narrative/ShellToolCallRow.tsx` | **22** | 2 |
| `apps/web/src/features/conversation/narrative/NarrativeRow.tsx` | **22** | 1 |
| `apps/web/src/lib/diff-parser.ts` | **22** | 1 |
| `apps/web/src/features/pull-requests/state/pullRequestDetailStore.ts` | **22** | 4 |
| `apps/web/src/components/diff/SummaryView.tsx` | **22** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestDetailHeader.tsx` | **22** | 1 |
| `apps/web/src/components/diff/CumulativeView.tsx` | **22** | 1 |
| `apps/web/src/lib/summon-tab.ts` | **21** | 1 |
| `apps/web/src/features/terminal/surfaces/terminalLinkProvider.ts` | **21** | 1 |
| `apps/web/src/features/pull-requests/state/pullRequestStore.ts` | **21** | 1 |
| `apps/web/src/hooks/useThreadGitActions.ts` | **21** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestDetailToolbar.tsx` | **21** | 1 |
| `apps/web/src/features/preview/automation/services/__tests__/browserSessionDriver.races.test.ts` | **21** | 4 |
| `apps/web/src/features/conversation/messages/selected-text-projection.ts` | **21** | 2 |
| `apps/web/src/components/chat/MarkdownContent.tsx` | **20** | 2 |
| `apps/web/src/lib/semver.ts` | **20** | 1 |
| `apps/web/src/features/terminal/surfaces/TerminalPoolHost.tsx` | **20** | 1 |
| `apps/web/src/lib/format-cursor-model-id.ts` | **20** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestSurface.tsx` | **20** | 1 |
| `apps/web/src/features/pull-requests/hooks/usePullRequestDiffHighlighter.ts` | **20** | 2 |
| `apps/web/src/features/projects/environment/ProjectActionControl.tsx` | **20** | 4 |
| `apps/web/src/features/conversation/messages/timeline/TranscriptItemRenderer.tsx` | **20** | 2 |
| `apps/web/src/components/chat/ImageAttachmentLightbox.tsx` | **19** | 1 |
| `apps/web/src/lib/workspace-thread.ts` | **19** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestVirtualDiff.tsx` | **19** | 3 |
| `apps/web/src/features/pull-requests/lib/pull-request-diff-row-model.ts` | **19** | 6 |
| `apps/web/src/features/conversation/narrative/CommandExecutionCard.tsx` | **19** | 2 |
| `apps/web/src/components/chat/useFileAutocomplete.ts` | **18** | 1 |
| `apps/web/src/components/chat/ToolCallCard.tsx` | **18** | 1 |
| `apps/web/src/features/preview/automation/services/viewportCoordinator.ts` | **18** | 3 |
| `apps/web/src/features/conversation/narrative/subagent-lifecycle.ts` | **18** | 2 |
| `apps/web/src/components/chat/CodeBlock.tsx` | **18** | 1 |
| `apps/web/src/components/tasks/TaskItem.tsx` | **18** | 1 |
| `apps/web/src/features/projects/environment/ProjectEnvironmentPanel.tsx` | **18** | 1 |
| `apps/web/src/transport/ws-transport.ts` | **17** | 1 |
| `apps/web/src/transport/ws-events.ts` | **17** | 1 |
| `apps/web/src/transport/index.ts` | **17** | 1 |
| `apps/web/src/stores/threadControlStore.ts` | **17** | 1 |
| `apps/web/src/components/chat/BranchPicker.tsx` | **17** | 1 |
| `apps/web/src/components/sidebar/ThreadStateMarker.tsx` | **17** | 2 |
| `apps/web/src/components/ShortcutHelpDialog.tsx` | **17** | 1 |
| `apps/web/src/components/chat/user-message-preview.ts` | **17** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestFileTree.tsx` | **17** | 3 |
| `apps/web/src/features/projects/ProjectRow.tsx` | **17** | 1 |
| `apps/web/src/components/panels/ActivityRail.tsx` | **16** | 4 |
| `apps/web/src/components/chat/MermaidBlock.tsx` | **16** | 2 |
| `apps/web/src/hooks/useDiffHighlighter.ts` | **16** | 1 |
| `apps/web/src/components/chat/ComposerQueueList.tsx` | **16** | 1 |
| `apps/web/src/lib/model-registry.ts` | **16** | 1 |
| `apps/web/src/features/terminal/state/terminalStore.ts` | **16** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestDiffViewport.tsx` | **16** | 1 |
| `apps/web/src/features/preview/state/previewTabsStore.ts` | **16** | 3 |
| `apps/web/src/features/subagents/roster/SubagentsPanel.tsx` | **15** | 2 |
| `apps/web/src/components/panels/CoordinationPanel.tsx` | **15** | 2 |
| `apps/web/src/components/chat/popup-position.ts` | **15** | 1 |
| `apps/web/src/components/chat/plan-questions/OptionTile.tsx` | **15** | 1 |
| `apps/web/src/features/terminal/surfaces/TerminalSearchShelf.tsx` | **15** | 1 |
| `apps/web/src/stores/settingsStore.ts` | **15** | 1 |
| `apps/web/src/lib/remark-github-disclosures.ts` | **15** | 1 |
| `apps/web/src/features/preview/automation/webBrowserSemanticRegistry.ts` | **15** | 1 |
| `apps/web/src/stores/turn-response-projection.ts` | **14** | 1 |
| `apps/web/src/components/chat/lexical/MentionPlugin.tsx` | **14** | 1 |
| `apps/web/src/components/chat/FileTagPopup.tsx` | **14** | 1 |
| `apps/web/src/components/chat/EntityToken.tsx` | **14** | 1 |
| `apps/web/src/features/preview/capture/usePreviewCapture.ts` | **14** | 1 |
| `apps/web/src/hooks/useThreadRecap.ts` | **14** | 3 |
| `apps/web/src/features/pull-requests/state/pull-request-selectors.ts` | **14** | 2 |
| `apps/web/src/features/preview/surfaces/BrowserViewportToolbar.tsx` | **14** | 1 |
| `apps/web/src/features/pull-requests/surfaces/PullRequestForkDialog.tsx` | **14** | 2 |
| `apps/web/src/features/preview/surfaces/BrowserSurfaceHostRoot.tsx` | **14** | 1 |
| `apps/web/src/features/projects/environment/ProjectSetupControl.tsx` | **14** | 2 |
| `apps/web/src/features/preview/state/previewAnnotationStore.ts` | **14** | 1 |
| `apps/web/src/components/chat/tool-renderers/ToolCallWrapper.tsx` | **13** | 1 |
| `apps/web/src/stores/composerDraftStore.ts` | **13** | 1 |
| `apps/web/src/components/chat/PermissionRequestCard.tsx` | **13** | 1 |
| `apps/web/src/stores/thread-record.ts` | **13** | 1 |
| `apps/web/src/features/conversation/narrative/__tests__/build-persisted-narrative.test.ts` | **13** | 1 |
| `apps/web/src/features/conversation/narrative/SubagentRow.tsx` | **13** | 1 |
| `apps/web/src/stores/sidebarSearchStore.ts` | **13** | 1 |
| `apps/web/src/features/preview/browser-surfaces/WebIframeBrowserSurfaceAdapter.ts` | **13** | 1 |
| `apps/web/src/components/palette/views/ThreadSearchView.tsx` | **13** | 1 |
| `apps/web/src/components/palette/CommandPalette.logic.ts` | **13** | 1 |
| `apps/web/src/features/pull-requests/state/pull-request-detail-selectors.ts` | **13** | 2 |
| `apps/web/src/hooks/useHighlighter.ts` | **13** | 1 |
| `apps/web/src/features/projects/__tests__/ProjectTree.test.tsx` | **13** | 1 |
| `apps/web/src/__tests__/record-cache.test.ts` | **13** | 1 |
| `apps/web/src/components/panels/plan/PlanPanel.tsx` | **12** | 1 |
| `apps/web/src/components/panels/plan/PlanDocument.tsx` | **12** | 1 |
| `apps/web/src/components/chat/RetryBanner.tsx` | **12** | 1 |
| `apps/web/src/components/chat/HookActivitySection.tsx` | **12** | 1 |
| `apps/web/src/components/chat/DiffViewer.tsx` | **12** | 1 |
| `apps/web/src/features/conversation/narrative/tool-detail.ts` | **12** | 1 |
| `apps/web/src/features/conversation/narrative/PersistedTurnFooter.tsx` | **12** | 1 |
| `apps/web/src/lib/format-model-label.ts` | **12** | 1 |
| `apps/web/src/components/sidebar/Sidebar.tsx` | **12** | 1 |
| `apps/web/src/components/settings/sections/ProviderSection.tsx` | **12** | 1 |
| `apps/web/src/lib/chat-highlight-coordinator.ts` | **12** | 1 |
| `apps/web/src/features/pull-requests/state/pull-request-code-selectors.ts` | **12** | 1 |
| `apps/web/src/features/projects/state/__tests__/workspace-behavior.test.ts` | **12** | 2 |
| `apps/web/src/features/conversation/hydration/auxiliary-hydrator.ts` | **12** | 1 |
| `apps/web/src/features/conversation/narrative/HookRow.tsx` | **12** | 1 |
| `apps/web/src/components/chat/StickyUserMessage.tsx` | **11** | 1 |
| `apps/web/src/features/preview/automation/browserAutomationRuntime.ts` | **11** | 1 |
| `apps/web/src/components/chat/lexical/MentionNode.tsx` | **11** | 1 |
| `apps/web/src/features/conversation/narrative/__tests__/parallel-subagent-nesting.test.ts` | **11** | 1 |
| `apps/web/src/lib/turn-snapshot-refresh.ts` | **11** | 1 |
| `apps/web/src/lib/load-file-diff.ts` | **11** | 1 |
| `apps/web/src/components/tasks/TaskPanelHeader.tsx` | **11** | 1 |
| `apps/web/src/components/files/FilesPanel.tsx` | **11** | 1 |
| `apps/web/src/features/preview/surfaces/PreviewWebview.tsx` | **11** | 1 |
| `apps/web/src/components/chat/WorktreePicker.tsx` | **11** | 1 |
| `apps/web/src/features/pull-requests/lib/pull-request-file-tree.ts` | **11** | 1 |
| `apps/web/src/components/diff/BranchRefPicker.tsx` | **11** | 1 |
| `apps/web/src/features/conversation/hydration/conversation-memory-policy.ts` | **11** | 1 |
| `apps/web/src/features/conversation/narrative/extract-subagent-description.ts` | **11** | 1 |

### apps/server (105 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `apps/server/src/application/transport/ws-router.ts` | **343** | 4 |
| `apps/server/src/features/providers/adapters/claude/claude-provider.ts` | **184** | 7 |
| `apps/server/src/features/agents/turns/turn-file-tracker.ts` | **50** | 7 |
| `apps/server/src/features/thread-control/cleanup/cleanup-worker.ts` | **46** | 2 |
| `apps/server/src/features/browser-automation/transport/mcp-handler.ts` | **46** | 2 |
| `apps/server/src/features/pull-requests/github/github-pull-request-detail-normalizers.ts` | **44** | 5 |
| `apps/server/src/runtime/process/containment/process-kill.ts` | **41** | 4 |
| `apps/server/src/features/handoff/orchestration/handoff-coordinator.ts` | **36** | 1 |
| `apps/server/src/features/providers/adapters/copilot/copilot-provider.ts` | **36** | 6 |
| `apps/server/src/features/pull-requests/github/github-pull-request-client.ts` | **35** | 7 |
| `apps/server/src/features/providers/catalog/codex-catalog-service.ts` | **35** | 6 |
| `apps/server/src/features/agents/conversation/narrative/narrative-store.ts` | **35** | 7 |
| `apps/server/src/runtime/persistence/sqlite/database.ts` | **33** | 3 |
| `apps/server/src/runtime/process/containment/windows-process-scope.ts` | **32** | 2 |
| `apps/server/src/features/browser-automation/execution/broker.ts` | **32** | 14 |
| `apps/server/src/application/transport/ws-server.ts` | **31** | 3 |
| `apps/server/src/features/terminal/backends/legacy/terminal-service.ts` | **31** | 5 |
| `apps/server/src/features/handoff/artifacts/path-d-deterministic.ts` | **30** | 1 |
| `apps/server/src/features/browser-automation/observability/telemetry.ts` | **30** | 3 |
| `apps/server/src/features/agents/canonical/canonical-agent-boundary.ts` | **29** | 8 |
| `apps/server/src/runtime/process/orphan-cleanup.ts` | **29** | 2 |
| `apps/server/src/features/terminal/host/__tests__/pty-host-supervisor.real.test.ts` | **28** | 1 |
| `apps/server/src/features/agents/turns/turn-finalizer.ts` | **27** | 4 |
| `apps/server/src/features/pull-requests/queries/pull-request-service.ts` | **27** | 6 |
| `apps/server/src/features/projects/environment/project-action-service.ts` | **26** | 1 |
| `apps/server/src/features/thread-control/authority/thread-control-service.ts` | **25** | 13 |
| `apps/server/src/features/terminal/sessions/terminal-session-runtime.ts` | **24** | 3 |
| `apps/server/src/features/thread-control/persistence/thread-repo.ts` | **23** | 5 |
| `apps/server/src/features/providers/transport/provider-catalog.ts` | **23** | 1 |
| `apps/server/src/features/terminal/host/pty-host-supervisor.ts` | **23** | 2 |
| `apps/server/src/features/projects/environment/workspace-environment-automatic-repository.ts` | **22** | 1 |
| `apps/server/src/features/thread-control/external/__tests__/external-thread-control-pairing-service.test.ts` | **22** | 2 |
| `apps/server/src/features/projects/environment/workspace-environment-service.ts` | **21** | 7 |
| `apps/server/src/application/bootstrap/server-bootstrap.ts` | **21** | 2 |
| `apps/server/src/features/thread-control/authority/thread-control-mcp-runtime.ts` | **21** | 1 |
| `apps/server/src/features/agents/conversation/persistence/message-repo.ts` | **21** | 3 |
| `apps/server/src/application/transport/push.ts` | **20** | 2 |
| `apps/server/src/features/handoff/orchestration/error-classifier.ts` | **20** | 1 |
| `apps/server/src/features/agents/turns/turn-runtime.ts` | **20** | 1 |
| `apps/server/scripts/run-terminal-workload-corpus.ts` | **20** | 2 |
| `apps/server/src/features/agents/turns/parent-assistant-text-checkpoint-service.ts` | **20** | 7 |
| `apps/server/src/runtime/reliability-harness/control.ts` | **19** | 3 |
| `apps/server/src/features/agents/recovery/turn-recovery-service.ts` | **19** | 2 |
| `apps/server/src/features/terminal/testing/terminal-workload-corpus.ts` | **19** | 1 |
| `apps/server/src/features/projects/git/pull-request-review-git-service.ts` | **19** | 4 |
| `apps/server/src/features/projects/git/git-worktree-service.ts` | **19** | 3 |
| `apps/server/src/features/projects/worktrees/thread-branching-service.ts` | **19** | 1 |
| `apps/server/src/features/pull-requests/github/github-service.ts` | **18** | 6 |
| `apps/server/src/features/agents/conversation/read-model/conversation-page.ts` | **18** | 2 |
| `apps/server/src/features/providers/catalog/codex-custom-prompt-service.ts` | **18** | 2 |
| `apps/server/src/features/projects/git/git-comparison-service.ts` | **18** | 6 |
| `apps/server/src/features/terminal/backends/modern/modern-terminal-backend.ts` | **18** | 5 |
| `apps/server/src/features/agents/commands/goal-command.ts` | **17** | 1 |
| `apps/server/src/features/browser-automation/access/browser-automation-session-lease.ts` | **17** | 2 |
| `apps/server/src/features/agents/collaboration/adapters/codex-collaboration-event-adapter.ts` | **16** | 2 |
| `apps/server/src/features/agents/canonical/canonical-conversation-projection-reader.ts` | **16** | 2 |
| `apps/server/src/features/projects/diffs/snapshots/snapshot-service.ts` | **16** | 2 |
| `apps/server/src/features/agents/observability/canonical-agent-diagnostics.ts` | **16** | 1 |
| `apps/server/src/features/thread-control/authority/thread-control-mcp-transport.ts` | **16** | 1 |
| `apps/server/src/features/terminal/preferences/terminal-settings-migration.ts` | **16** | 1 |
| `apps/server/src/runtime/persistence/sqlite/bounded-write-batches.ts` | **16** | 2 |
| `apps/server/src/features/projects/git/__tests__/git-service-branch-comparison.test.ts` | **16** | 1 |
| `apps/server/src/features/browser-automation/access/credential-registry.ts` | **15** | 1 |
| `apps/server/src/features/agents/orchestration/__tests__/agent-service-goal-command.test.ts` | **15** | 1 |
| `apps/server/src/features/agents/conversation/migrations/legacy-conversation-migration.ts` | **15** | 1 |
| `apps/server/src/features/agents/turns/thread-creation-coordinator.ts` | **15** | 1 |
| `apps/server/src/features/terminal/commands/terminal-command-service.ts` | **15** | 2 |
| `apps/server/src/features/settings/settings-service.ts` | **15** | 1 |
| `apps/server/src/features/pull-requests/github/github-pull-request-file-normalizers.ts` | **14** | 4 |
| `apps/server/src/features/pull-requests/mutations/pull-request-mutation-service.ts` | **14** | 3 |
| `apps/server/src/features/agents/collaboration/delegation-target-resolver.ts` | **13** | 2 |
| `apps/server/src/features/pull-requests/drafts/pr-draft-service.ts` | **13** | 1 |
| `apps/server/src/features/agents/canonical/canonical-agent-event-store.ts` | **13** | 2 |
| `apps/server/src/features/agents/orchestration/provider-agent-error-normalize.ts` | **13** | 1 |
| `apps/server/src/features/providers/composition/provider-event-ingress.ts` | **13** | 2 |
| `apps/server/src/features/providers/adapters/cursor/usage/cursor-admin-usage-source.ts` | **13** | 1 |
| `apps/server/src/features/thread-control/authority/persistence/thread-control-approval-repo.ts` | **13** | 1 |
| `apps/server/src/features/terminal/host/pty-host-runtime.ts` | **13** | 1 |
| `apps/server/src/runtime/persistence/sqlite/performance/sqlite-profile.ts` | **13** | 3 |
| `apps/server/src/features/terminal/cleanup/terminal-cleanup-ledger.ts` | **13** | 1 |
| `apps/server/src/features/projects/git/git-repository-service.ts` | **13** | 2 |
| `apps/server/src/features/pull-requests/github/github-pull-request-normalizers.ts` | **12** | 1 |
| `apps/server/src/features/agents/orchestration/__tests__/agent-service-narrative-persist.test.ts` | **12** | 1 |
| `apps/server/src/features/thread-control/external/external-thread-control-pairing-service.ts` | **12** | 1 |
| `apps/server/src/features/handoff/orchestration/handoff-pipeline.ts` | **12** | 2 |
| `apps/server/src/features/agents/goals/goal-lifecycle-service.ts` | **12** | 1 |
| `apps/server/src/features/thread-control/cleanup/persistence/cleanup-job-repo.ts` | **12** | 1 |
| `apps/server/src/features/handoff/artifacts/handoff-builder.ts` | **12** | 1 |
| `apps/server/src/features/terminal/sessions/terminal-replay-buffer.ts` | **12** | 2 |
| `apps/server/src/features/agents/turns/turn-admission-dispatch-coordinator.ts` | **12** | 1 |
| `apps/server/src/features/terminal/host/pty-host-child.ts` | **12** | 1 |
| `apps/server/src/features/browser-automation/transport/__tests__/mcp-conformance.test.ts` | **12** | 1 |
| `apps/server/src/features/projects/lifecycle/filesystem-browser.ts` | **12** | 1 |
| `apps/server/src/features/pull-requests/reviews/review-worktree-service.ts` | **12** | 1 |
| `apps/server/src/features/projects/worktrees/project-worktree-service.ts` | **12** | 2 |
| `apps/server/src/features/projects/environment/__tests__/workspace-environment-service.test.ts` | **11** | 1 |
| `apps/server/src/features/agents/planning/plan-question-service.ts` | **11** | 1 |
| `apps/server/src/features/thread-control/lifecycle/thread-completion-service.ts` | **11** | 1 |
| `apps/server/src/features/agents/orchestration/agent-service.ts` | **11** | 1 |
| `apps/server/src/features/providers/adapters/copilot/copilot-cli-resolver.ts` | **11** | 1 |
| `apps/server/src/features/providers/adapters/copilot/copilot-agent-discovery.ts` | **11** | 1 |
| `apps/server/src/features/agents/skills/catalog/skill-service.ts` | **11** | 2 |
| `apps/server/src/features/providers/adapters/claude/claude-goal-command-parser.ts` | **11** | 1 |
| `apps/server/src/features/terminal/backends/legacy/terminal-replay-buffer.ts` | **11** | 1 |
| `apps/server/src/features/projects/files/file-service.ts` | **11** | 1 |

### apps/desktop (33 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `apps/desktop/src/features/preview/automation/kernel.ts` | **65** | 18 |
| `apps/desktop/src/features/server-runtime/process/manager.ts` | **46** | 4 |
| `apps/desktop/src/features/preview/capture/handlers.ts` | **40** | 4 |
| `apps/desktop/src/features/preview/automation/__tests__/browser-automation-kernel.test.ts` | **38** | 1 |
| `apps/desktop/src/features/preview/tabs/handlers.ts` | **32** | 4 |
| `apps/desktop/src/features/preview/automation/__tests__/browser-executor-parity.test.ts` | **31** | 5 |
| `apps/desktop/src/features/preview/surfaces/registry.ts` | **30** | 5 |
| `apps/desktop/scripts/desktop-packaging/package-validation/desktop-reliability-test.mjs` | **29** | 3 |
| `apps/desktop/scripts/desktop-packaging/target-package/target-package.mjs` | **28** | 2 |
| `apps/desktop/scripts/desktop-packaging/package-validation/terminal-artifact-attestation.mjs` | **25** | 2 |
| `apps/desktop/src/features/preview/capture/overlay.ts` | **25** | 6 |
| `apps/desktop/src/features/server-runtime/reliability-harness/control.ts` | **24** | 3 |
| `apps/desktop/src/features/preview/navigation/handlers.ts` | **22** | 1 |
| `apps/desktop/src/features/preview/navigation/local-file.ts` | **21** | 3 |
| `apps/desktop/src/features/preview/contracts/guest-input.ts` | **21** | 1 |
| `apps/desktop/src/features/application-updates/policy/release-line.ts` | **20** | 1 |
| `apps/desktop/scripts/desktop-packaging/target-package/build-server-binary.mjs` | **20** | 1 |
| `apps/desktop/src/features/preview/automation/__tests__/browser-automation-kernel-races.test.ts` | **20** | 3 |
| `apps/desktop/scripts/desktop-packaging/target-package/ci-package.mjs` | **19** | 1 |
| `apps/desktop/scripts/desktop-packaging/package-validation/terminal-release-evidence.mjs` | **18** | 1 |
| `apps/desktop/src/features/desktop-window/actions/window-actions.ts` | **18** | 1 |
| `apps/desktop/src/features/preview/navigation/resolve-target.ts` | **17** | 1 |
| `apps/desktop/src/features/application-updates/lifecycle/installation.ts` | **17** | 2 |
| `apps/desktop/src/features/application-updates/configuration/settings.ts` | **16** | 1 |
| `apps/desktop/src/features/preview/tabs/discard-scheduler.ts` | **16** | 1 |
| `apps/desktop/src/features/preview/state/window-session.ts` | **16** | 1 |
| `apps/desktop/scripts/desktop-packaging/publishers/merge-electron-update-metadata.mjs` | **15** | 1 |
| `apps/desktop/scripts/desktop-packaging/target-package/after-pack.mjs` | **15** | 1 |
| `apps/desktop/src/features/preview/state/page-status.ts` | **15** | 1 |
| `apps/desktop/src/features/attachments/protocol/handler.ts` | **13** | 1 |
| `apps/desktop/scripts/desktop-packaging/target-inventory/target-inventory.mjs` | **13** | 1 |
| `apps/desktop/src/features/preview/automation/redaction.ts` | **12** | 1 |
| `apps/desktop/src/main/main.ts` | **12** | 1 |

### packages/providers (16 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `packages/providers/src/private/codex/codex-event-mapper.ts` | **113** | 13 |
| `packages/providers/src/private/codex/codex-provider.ts` | **85** | 14 |
| `packages/providers/src/private/codex/codex-trace.ts` | **37** | 1 |
| `packages/providers/src/private/cursor/acp/cursor-acp-session-trace.ts` | **33** | 2 |
| `packages/providers/src/private/codex/codex-app-server.ts` | **29** | 6 |
| `packages/providers/src/private/codex/codex-permission-mapper.ts` | **20** | 1 |
| `packages/providers/src/private/codex/codex-agent-discovery.ts` | **19** | 1 |
| `packages/providers/src/__tests__/codex/codex-event-mapper.test.ts` | **19** | 2 |
| `packages/providers/src/conformance/sanitizer.ts` | **17** | 1 |
| `packages/providers/src/conformance/deterministic-sink.ts` | **15** | 1 |
| `packages/providers/src/private/cursor/acp/cursor-acp-ask-question.ts` | **15** | 1 |
| `packages/providers/src/private/protocols/acp/acp-session-runtime.ts` | **14** | 2 |
| `packages/providers/src/private/codex/codex-rpc-client.ts` | **13** | 1 |
| `packages/providers/src/private/cursor/stream-json/cursor-stream-event-mapper.ts` | **13** | 2 |
| `packages/providers/src/private/codex/codex-prompt.ts` | **12** | 1 |
| `packages/providers/src/private/cursor/models/cursor-cli-models.ts` | **11** | 1 |

### packages/contracts (7 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `packages/contracts/src/models/workspace-environment.ts` | **50** | 3 |
| `packages/contracts/src/ws/terminal-binary.ts` | **33** | 2 |
| `packages/contracts/src/models/browser-narrative.ts` | **29** | 1 |
| `packages/contracts/src/models/workspace-preview-uri.ts` | **16** | 1 |
| `packages/contracts/src/models/browser-automation.ts` | **15** | 1 |
| `packages/contracts/src/models/terminal-diagnostics.ts` | **12** | 1 |
| `packages/contracts/src/models/conversation-older-page.ts` | **11** | 1 |

### packages/shared (2 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `packages/shared/src/model-effort/index.ts` | **13** | 1 |
| `packages/shared/src/git/index.ts` | **13** | 1 |

### packages/agent-model (1 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `packages/agent-model/src/reducer.ts` | **44** | 1 |

### packages/browser-conformance (7 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `packages/browser-conformance/src/executor.ts` | **25** | 2 |
| `packages/browser-conformance/src/normalize.ts` | **24** | 4 |
| `packages/browser-conformance/src/cleanup.ts` | **24** | 2 |
| `packages/browser-conformance/src/model.ts` | **19** | 1 |
| `packages/browser-conformance/src/replay.ts` | **15** | 1 |
| `packages/browser-conformance/src/races.ts` | **14** | 1 |
| `packages/browser-conformance/src/schedule.ts` | **11** | 1 |

### scripts (18 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `scripts/perf/frontend-renderer-fixture.mjs` | **67** | 10 |
| `scripts/build-server-dev-bundle.mjs` | **30** | 1 |
| `scripts/codex-trace.mjs` | **26** | 1 |
| `scripts/agent/runtime-contract.mjs` | **24** | 1 |
| `scripts/codex-protocol-capture.mjs` | **23** | 1 |
| `scripts/agent/verify-tests.mjs` | **23** | 9 |
| `scripts/perf/run-packaged-windows-acceleration.mjs` | **18** | 1 |
| `scripts/codex-stop-verify.mjs` | **17** | 1 |
| `scripts/perf/frontend-performance-collectors.mjs` | **17** | 1 |
| `scripts/codex-live-verify.mjs` | **16** | 1 |
| `scripts/perf/run-frontend-performance.mjs` | **14** | 2 |
| `scripts/resolve-cli-db-path.mjs` | **12** | 1 |
| `scripts/perf/frontend-performance-worker.mjs` | **12** | 1 |
| `scripts/agent/cleanup-superseded-nightlies.mjs` | **12** | 2 |
| `scripts/agent/__tests__/run-electron-node.test.mjs` | **11** | 1 |
| `scripts/security/check-bun-audit-baseline.mjs` | **11** | 1 |
| `scripts/perf/packaged-windows-performance-worker.mjs` | **11** | 1 |
| `scripts/agent/agent-up.mjs` | **11** | 1 |

### other (4 files)

| File Path | Max Complexity | Violations Count |
| :--- | :---: | :---: |
| `.codex/skills/electorn-live-testing/scripts/start-electron.mjs` | **40** | 2 |
| `.codex/skills/electorn-live-testing/scripts/electron-session.mjs` | **16** | 2 |
| `.codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs` | **14** | 1 |
| `.codex/skills/electorn-live-testing/scripts/process-tree.mjs` | **11** | 1 |
