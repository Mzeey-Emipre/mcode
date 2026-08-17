// Models
export {
  ThreadStatusSchema,
  ThreadModeSchema,
  MessageRoleSchema,
  PermissionModeSchema,
  PERMISSION_MODES,
  InteractionModeSchema,
  INTERACTION_MODES,
  OrchestrationModeSchema,
  ORCHESTRATION_MODES,
  CopilotSubagentSourceSchema,
  COPILOT_SUBAGENT_SOURCES,
} from "./models/enums.js";
export type {
  ThreadStatus,
  ThreadMode,
  MessageRole,
  PermissionMode,
  InteractionMode,
  OrchestrationMode,
  CopilotSubagentSource,
} from "./models/enums.js";

export {
  AttachmentMetaSchema,
  StoredAttachmentSchema,
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  isVirtualBrowserContextAttachment,
  shouldPersistAttachmentWithoutFile,
  storedAttachmentSuffix,
} from "./models/attachment.js";
export type { AttachmentMeta, StoredAttachment } from "./models/attachment.js";

export { WorkspaceSchema, WorkspaceEnrichmentSchema } from "./models/workspace.js";
export type { Workspace, WorkspaceEnrichment } from "./models/workspace.js";

export {
  TurnExecutionIdSchema,
  TurnRuntimePhaseSchema,
  TurnRuntimeSnapshotSchema,
  AgentStopDispatchStateSchema,
  AgentStopResultSchema,
} from "./models/turn-runtime.js";

export {
  CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS,
  CanonicalAgentReconnectRecoverySchema,
  CanonicalAgentRevisionSchema,
  CanonicalAgentSnapshotSchema,
} from "./models/canonical-agent-reconnect.js";
export type {
  CanonicalAgentReconnectRecovery,
  CanonicalAgentRevision,
  CanonicalAgentSnapshot,
} from "./models/canonical-agent-reconnect.js";
export type {
  TurnExecutionId,
  TurnRuntimePhase,
  TurnRuntimeSnapshot,
  AgentStopDispatchState,
  AgentStopResult,
} from "./models/turn-runtime.js";

export {
  THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH,
  WORKSPACE_SEARCH_QUERY_MAX_LENGTH,
  WORKSPACE_SEARCH_LIMIT_MAX,
  WORKSPACE_SEARCH_LIMIT_DEFAULT,
  THREAD_CREATE_BATCH_MAX_ITEMS,
  THREAD_CREATE_TITLE_MAX_LENGTH,
  THREAD_CREATE_PROMPT_MAX_LENGTH,
  THREAD_SEND_MESSAGE_MAX_LENGTH,
  THREAD_CREATE_EXECUTION_ID_MAX_LENGTH,
  THREAD_TARGET_PROVIDER_MAX,
  THREAD_TARGET_MODEL_MAX,
  THREAD_CREATE_GIT_REF_MAX_LENGTH,
  THREAD_SEARCH_WORKSPACE_IDS_MAX,
  THREAD_SEARCH_STATUSES_MAX,
  THREAD_SEARCH_LIMIT_MAX,
  THREAD_SEARCH_LIMIT_DEFAULT,
  THREAD_GET_MESSAGE_LIMIT_MAX,
  THREAD_GET_MESSAGE_LIMIT_DEFAULT,
  THREAD_GET_TRANSCRIPT_MAX_BYTES,
  THREAD_WAIT_TARGETS_MAX,
  THREAD_WAIT_TIMEOUT_MAX_SECONDS,
  THREAD_WAIT_TIMEOUT_DEFAULT_SECONDS,
  WorkspaceSearchInputSchema,
  WorkspaceSearchResultSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
  ThreadControlErrorSchema,
  ThreadPlacementSchema,
  ResolvedExecutionSchema,
  ResolvedPlacementSchema,
  ThreadCreateInputSchema,
  ThreadCreateBatchInputSchema,
  ThreadCreateItemResultSchema,
  ThreadCreateBatchResultSchema,
  ThreadTargetListInputSchema,
  ThreadTargetProviderSchema,
  ThreadTargetListResultSchema,
  ThreadObservedStateSchema,
  ThreadSearchInputSchema,
  ThreadRefSchema,
  ThreadSearchResultSchema,
  MessageOriginSchema,
  ThreadReadMessageSchema,
  ThreadGetInputSchema,
  ThreadGetResultSchema,
  ThreadControlIdentitySchema,
  ThreadControlThreadRefSchema,
  ThreadControlRelationSchema,
  ThreadControlReadInputSchema,
  ThreadControlProjectionSchema,
  ThreadControlReadResultSchema,
  ThreadControlMutationTargetSchema,
  ThreadControlUserSendInputSchema,
  ThreadControlUserStopInputSchema,
  ThreadSendInputSchema,
  ThreadSendResultSchema,
  ThreadStopInputSchema,
  ThreadStopResultSchema,
  ThreadWaitUntilSchema,
  ThreadWaitInputSchema,
  ThreadWaitItemSchema,
  ThreadWaitResultSchema,
} from "./thread-control.js";
export type {
  WorkspaceSearchInput,
  WorkspaceSearchResult,
  WorktreeListInput,
  WorktreeListResult,
  ThreadControlError,
  ThreadPlacement,
  ResolvedExecution,
  ResolvedPlacement,
  ThreadCreateInput,
  ThreadCreateBatchInput,
  ThreadCreateItemResult,
  ThreadCreateBatchResult,
  ThreadTargetListInput,
  ThreadTargetProvider,
  ThreadTargetListResult,
  ThreadObservedState,
  ThreadSearchInput,
  ThreadRef,
  ThreadSearchResult,
  MessageOrigin,
  ThreadReadMessage,
  ThreadGetInput,
  ThreadGetResult,
  ThreadControlIdentity,
  ThreadControlThreadRef,
  ThreadControlRelation,
  ThreadControlReadInput,
  ThreadControlProjection,
  ThreadControlReadResult,
  ThreadControlMutationTarget,
  ThreadControlUserSendInput,
  ThreadControlUserStopInput,
  ThreadSendInput,
  ThreadSendResult,
  ThreadStopInput,
  ThreadStopResult,
  ThreadWaitUntil,
  ThreadWaitInput,
  ThreadWaitItem,
  ThreadWaitResult,
} from "./thread-control.js";

export {
  MCODE_WORKSPACE_PREVIEW_PROTOCOL,
  isMcodeWorkspacePreviewUrl,
  mcodeWorkspacePreviewHref,
  markdownWorkspaceRefToPreviewPath,
  looksLikeWorkspaceRelativeFileRef,
} from "./models/workspace-preview-uri.js";

export { ThreadSchema, RecentThreadSchema, ThreadCheckoutStateSchema } from "./models/thread.js";
export type { Thread, RecentThread, ThreadCheckoutState } from "./models/thread.js";

export {
  MAX_TURN_RECOVERIES,
  TurnRecoveryActionSchema,
  TurnRecoverySchema,
} from "./models/turn-recovery.js";
export type { TurnRecoveryAction, TurnRecovery } from "./models/turn-recovery.js";

export {
  MessageSchema,
  PaginatedMessagesSchema,
  ParentAgentMessageProvenanceSchema,
} from "./models/message.js";
export type {
  Message,
  PaginatedMessages,
  ParentAgentMessageProvenance,
} from "./models/message.js";

export {
  MessageMentionSchema,
  MessageMentionsSchema,
  MAX_MESSAGE_MENTIONS,
} from "./models/mention.js";
export type { MessageMention } from "./models/mention.js";

export {
  GoalControlsSchema,
  GoalObjectiveSchema,
  GoalLookupReasonSchema,
  GoalLookupResultSchema,
  GoalLookupSourceSchema,
  GoalStateSchema,
  GoalStatusSchema,
  isGoalOpen,
  isGoalStatusOpen,
  MAX_GOAL_OBJECTIVE_CHARS,
} from "./models/goal.js";
export type {
  GoalControls,
  GoalLookupReason,
  GoalLookupResult,
  GoalLookupSource,
  GoalState,
  GoalStatus,
} from "./models/goal.js";

export {
  ConversationPageSchema,
  ConversationNarrativeBatchSchema,
} from "./models/conversation-page.js";
export type {
  ConversationPage,
  ConversationNarrativeBatch,
} from "./models/conversation-page.js";
export {
  CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH,
  CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
  CANONICAL_SUBAGENT_TASK_MAX_LENGTH,
  CanonicalSubagentRosterRequestSchema,
  CanonicalSubagentStopRequestSchema,
  CanonicalSubagentTerminalOutcomeSchema,
  CanonicalSubagentStopResultSchema,
  CanonicalSubagentRosterRowSchema,
  CanonicalSubagentRosterSchema,
  canonicalSubagentTerminalOutcome,
} from "./models/canonical-subagent-roster.js";
export type {
  CanonicalSubagentRosterRequest,
  CanonicalSubagentStopRequest,
  CanonicalSubagentTerminalOutcome,
  CanonicalSubagentStopResult,
  CanonicalSubagentRosterRow,
  CanonicalSubagentRoster,
} from "./models/canonical-subagent-roster.js";
export {
  CONVERSATION_OLDER_PAGE_MAX_BYTES,
  CONVERSATION_OLDER_PAGE_MAX_MESSAGES,
  CONVERSATION_OLDER_PAGE_MAX_REQUEST_BYTES,
  CONVERSATION_OLDER_PAGE_MIN_BYTES,
  ConversationOlderPageCursorSchema,
  ConversationOlderPageIdentitySchema,
  ConversationOlderPageRequestSchema,
  ConversationOlderPageSchema,
} from "./models/conversation-older-page.js";
export type {
  ConversationOlderPage,
  ConversationOlderPageCursor,
  ConversationOlderPageIdentity,
  ConversationOlderPageRequest,
} from "./models/conversation-older-page.js";
export {
  CONVERSATION_HISTORY_PAGE_MAX_BYTES,
  CONVERSATION_HISTORY_PAGE_MAX_MESSAGES,
  CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES,
  CONVERSATION_HISTORY_PAGE_MIN_BYTES,
  conversationHistoryPageBytes,
} from "./models/conversation-history-page.js";
export {
  ConversationNewerPageCursorSchema,
  ConversationNewerPageIdentitySchema,
  ConversationNewerPageRequestSchema,
  ConversationNewerPageSchema,
} from "./models/conversation-newer-page.js";
export type {
  ConversationNewerPage,
  ConversationNewerPageCursor,
  ConversationNewerPageIdentity,
  ConversationNewerPageRequest,
} from "./models/conversation-newer-page.js";

export {
  CONVERSATION_TAIL_MAX_MESSAGES,
  CONVERSATION_TAIL_THREAD_ID_MAX_LENGTH,
  ConversationTailMessageSchema,
  ConversationTailParamsSchema,
  ConversationTailSchema,
  ConversationTailResultSchema,
} from "./models/conversation-tail.js";
export type {
  ConversationTailMessage,
  ConversationTailParams,
  ConversationTail,
  ConversationTailResult,
} from "./models/conversation-tail.js";

export {
  ToolCallRecordSchema,
  ToolCallStatusSchema,
  PROVIDER_AGENT_KEY_MAX_LENGTH,
  SUBAGENT_DISPLAY_NAME_MAX_LENGTH,
  SUBAGENT_METADATA_MAX_LENGTH,
  resolveProviderAgentKey,
  resolveSubagentDisplayName,
  resolveSubagentMetadata,
} from "./models/tool-call-record.js";
export type {
  ToolCallRecord,
  ToolCallStatus,
} from "./models/tool-call-record.js";

export { ThoughtSegmentRecordSchema } from "./models/thought-segment.js";
export type { ThoughtSegmentRecord } from "./models/thought-segment.js";

export { HookExecutionRecordSchema } from "./models/hook-execution.js";
export type { HookExecutionRecord } from "./models/hook-execution.js";

export { NarrativeEntrySchema, TurnRangeSchema } from "./models/narrative-entry.js";
export type { NarrativeEntry, TurnRange } from "./models/narrative-entry.js";

export { TurnSnapshotSchema } from "./models/turn-snapshot.js";
export type { TurnSnapshot } from "./models/turn-snapshot.js";

export {
  FileEffectKindSchema,
  FileEffectSchema,
  TurnFileEffectSummarySchema,
  MAX_TURN_FILE_EFFECTS,
} from "./models/file-effect.js";
export type { FileEffect, TurnFileEffectSummary } from "./models/file-effect.js";

export {
  ReviewFileChangeTypeSchema,
  ReviewFileChangeSchema,
  ReviewComparisonSchema,
} from "./models/review-comparison.js";
export type {
  ReviewFileChange,
  ReviewComparison,
} from "./models/review-comparison.js";

export {
  SettingsSchema,
  PartialSettingsSchema,
  getDefaultSettings,
  ThemeSchema,
  AgentDefaultModeSchema,
  ReasoningLevelSchema,
  ContextWindowModeSchema,
  ProviderIdSchema,
  NamingModeSchema,
  UpdateCheckIntervalSchema,
  UpdateReleaseLineSchema,
  CompletedThreadRetentionDaysSchema,
  GRACE_PERIOD_DEFAULT_SECONDS,
  SERVER_HEAP_DEFAULT_MB,
  SERVER_HEAP_MIN_MB,
  SERVER_HEAP_MAX_MB,
  SERVER_HEAP_LEGACY_DEFAULT_MB,
} from "./models/settings.js";
export type {
  Settings,
  PartialSettings,
  Theme,
  AgentDefaultMode,
  ReasoningLevel,
  ContextWindowMode,
  SettingsProviderId,
  NamingMode,
  UpdateCheckInterval,
  UpdateReleaseLine,
  CompletedThreadRetentionDays,
} from "./models/settings.js";

export {
  classifyFile,
  isFileSupported,
  getMaxFileSize,
  getExtension,
  inferMimeType,
  MAX_ATTACHMENTS,
  SUPPORTED_EXTENSIONS,
  attachmentAcceptAttribute,
} from "./models/file-types.js";
export type { FileCategory } from "./models/file-types.js";

export {
  ATTACHMENT_IMAGE_AND_FALLBACK_MAX_BYTES,
  ATTACHMENT_PDF_MAX_BYTES,
  ATTACHMENT_TEXT_MAX_BYTES,
  ATTACHMENT_DOCUMENT_MAX_BYTES,
  getAttachmentMaxSizeForMime,
} from "./models/attachment-limits.js";

export {
  BrowserPreviewBoundsSchema,
  BrowserPreviewCaptureKindSchema,
  BrowserPreviewElementStyleSchema,
  McodeBrowserCaptureV1Schema,
  AttachedBrowserCaptureV1Schema,
  McodeBrowserCaptureV2Schema,
  AttachedBrowserCaptureV2Schema,
  AttachedBrowserCaptureSchema,
  BrowserCaptureSpillFileSchema,
  MCODE_BROWSER_CAPTURE_V1_STRING_MAX,
  MCODE_BROWSER_CAPTURE_V2_STRING_MAX,
  MCODE_BROWSER_CAPTURE_SPILL_APP_DATA_PATH_MAX,
  MCODE_BROWSER_CAPTURE_SPILL_ABSOLUTE_PATH_MAX,
  PREVIEW_ANNOTATION_STRING_MAX,
  PreviewAnnotationVisualProposalSchema,
  PreviewAnnotationPayloadSchema,
  DiffAnnotationPayloadSchema,
  ComposerAnnotationPayloadSchema,
  PreviewAnnotationBundleSchema,
  isDiffAnnotationPayload,
  isPreviewAnnotationPayload,
  isBrowserCaptureSpillAppDataPath,
  clampMcodeBrowserCaptureV2,
  clampAttachedBrowserCaptureForOutbound,
  previewAnnotationSnapshotAttachmentName,
  previewAnnotationSnapshotAttachmentMeta,
  previewAnnotationSnapshotStoredAttachment,
  previewAnnotationSnapshotAttachments,
  previewAnnotationSnapshotStoredAttachments,
} from "./models/browser-preview.js";
export type {
  BrowserPreviewBounds,
  BrowserPreviewCaptureKind,
  BrowserPreviewElementStyle,
  McodeBrowserCaptureV1,
  AttachedBrowserCaptureV1,
  McodeBrowserCaptureV2,
  AttachedBrowserCaptureV2,
  McodeBrowserCapture,
  AttachedBrowserCapture,
  BrowserCaptureSpillFile,
  PreviewAnnotationVisualProposal,
  PreviewAnnotationPayload,
  DiffAnnotationPayload,
  ComposerAnnotationPayload,
  PreviewAnnotationBundle,
} from "./models/browser-preview.js";

export {
  BrowserTabIdSchema,
  BrowserTabInfoSchema,
  BrowserTabSetSchema,
  BrowserPerfCountersSchema,
  BROWSER_TAB_INFO_STRING_MAX,
} from "./models/browser-tab.js";
export type {
  BrowserTabId,
  BrowserTabInfo,
  BrowserTabSet,
  BrowserPerfCounters,
} from "./models/browser-tab.js";

export {
  PreviewPagePhaseSchema,
  PreviewPageErrorSchema,
  PreviewPageStatusSchema,
  PREVIEW_PAGE_STATUS_STRING_MAX,
} from "./models/preview-page-status.js";
export type {
  PreviewPagePhase,
  PreviewPageError,
  PreviewPageStatus,
} from "./models/preview-page-status.js";

export {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_URL_CHARS,
  BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS,
  BROWSER_AUTOMATION_MAX_ELEMENTS,
  BROWSER_AUTOMATION_MAX_AX_NODES,
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_MAX_RECORDING_BYTES,
  BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
  BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS,
  BROWSER_AUTOMATION_ACT_MAX_STEPS,
  BROWSER_AUTOMATION_MAX_INSPECT_TABS,
  BROWSER_AUTOMATION_MAX_GUIDANCE_CHARS,
  BROWSER_AUTOMATION_MIN_VIEWPORT_PX,
  BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
  BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX,
  BROWSER_AUTOMATION_VIEWPORT_PRESENTATIONS,
  resolveBrowserAutomationViewportPresentationScale,
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_AUTOMATION_HOST_OPERATIONS,
  BROWSER_V2_CORE_OPERATIONS,
  BROWSER_AUTOMATION_OPERATION_METADATA,
  BROWSER_AUTOMATION_ERROR_CODES,
  BrowserAutomationUrlSchema,
  BrowserAutomationDiagnosticLocationSchema,
  BrowserAutomationTargetSchema,
  BrowserAutomationTruncationSchema,
  BrowserAutomationElementSchema,
  BrowserAutomationAccessibilityNodeSchema,
  BrowserAutomationConsoleEntrySchema,
  BrowserAutomationNetworkEntrySchema,
  BrowserAutomationActionEntrySchema,
  BrowserAutomationScreenshotSchema,
  BrowserAutomationSnapshotSchema,
  BrowserAutomationPerformanceMetricsSchema,
  BrowserAutomationControllerStateSchema,
  BrowserAutomationHostCapabilitySchema,
  BrowserAutomationHostRegistrationSchema,
  BrowserAutomationHostDispatchTargetSchema,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationCredentialClaimsSchema,
  BrowserAutomationRequestSchema,
  BrowserAutomationResultSchema,
  BrowserAutomationErrorSchema,
  BrowserAutomationResponseSchema,
  BROWSER_AUTOMATION_WEB_DEV_FLAG,
  BrowserAutomationHostRuntimeSchema,
  BrowserAutomationTargetIdentitySchema,
  BrowserAutomationExecutorDescriptorSchema,
  BrowserAutomationInspectTargetSchema,
  BrowserAutomationInspectReadinessSchema,
  BrowserAutomationActStepSchema,
  BrowserAutomationObservationBindingSchema,
  BrowserAutomationActResultSchema,
  BrowserAutomationEvaluateResultSchema,
  BrowserAutomationTabsArgsSchema,
  BrowserAutomationOwnedTabSchema,
  BrowserAutomationTabsResultSchema,
} from "./models/browser-automation.js";
export type {
  BrowserAutomationPublicOperation,
  BrowserAutomationOperation,
  BrowserAutomationRequestOperation,
  BrowserAutomationOperationAnnotations,
  BrowserAutomationOperationMetadata,
  BrowserAutomationTarget,
  BrowserAutomationDiagnosticLocation,
  BrowserAutomationTruncation,
  BrowserAutomationPerformanceMetrics,
  BrowserAutomationControllerState,
  BrowserAutomationHostRegistration,
  BrowserAutomationHostDispatchTarget,
  BrowserAutomationHostDispatch,
  BrowserAutomationCredentialClaims,
  BrowserAutomationRequest,
  BrowserAutomationResult,
  BrowserAutomationErrorCode,
  BrowserAutomationError,
  BrowserAutomationResponse,
  BrowserAutomationViewportPresentation,
  BrowserAutomationHostRuntime,
  BrowserAutomationTargetIdentity,
  BrowserAutomationExecutorDescriptor,
  BrowserAutomationActStep,
  BrowserAutomationObservationBinding,
  BrowserAutomationActResult,
  BrowserAutomationEvaluateResult,
  BrowserAutomationTabsArgs,
  BrowserAutomationOwnedTab,
  BrowserAutomationTabsResult,
} from "./models/browser-automation.js";

export {
  BROWSER_NARRATIVE_TOOLS,
  resolveBrowserNarrativeTool,
  projectBrowserNarrativeInput,
  projectBrowserNarrativeResult,
  serializeBrowserNarrativeResult,
} from "./models/browser-narrative.js";
export type {
  BrowserNarrativeTool,
  BrowserNarrativeStepInput,
  BrowserNarrativeInput,
  BrowserNarrativeReceipt,
  BrowserNarrativeResult,
} from "./models/browser-narrative.js";

// Events
export { AgentEventSchema, AgentEventType, AgentEventEpochSchema } from "./events/agent-event.js";
export type { AgentEvent } from "./events/agent-event.js";

// Canonical agent model compatibility boundary
export {
  AgentEventEnvelopeSchema,
  AgentEventIdSchema,
  AgentEventRoutingSchema,
  AgentItemIdSchema,
  AgentItemKindSchema,
  AgentItemSchema,
  AgentModelStateSchema,
  AgentThreadActivityStateSchema,
  AgentThreadIdSchema,
  AgentThreadSchema,
  AgentTurnExecutionIdSchema,
  AgentTurnIdSchema,
  AgentTurnStatusSchema,
  AgentTurnSchema,
  AgentTurnTriggerSchema,
  CanonicalAgentEventEnvelopeSchema,
  CanonicalAgentEventSchema,
  CanonicalTimestampSchema,
  CollaborationActionIdSchema,
  CollaborationActionKindSchema,
  CollaborationActionSchema,
  CollaborationActionStatusSchema,
  CollaborationSourceSchema,
  CollaborationTargetSchema,
  IdentityProvenanceSchema,
  ProviderCapabilityNameSchema,
  ProviderCapabilitySchema,
  ProviderCapabilitySupportSchema,
  ProviderIdentitySchema,
  ProviderIdentityScopeSchema,
  ProviderSchema,
  createAgentModelState,
  reduceAgentEvent,
  reduceAgentEventBatch,
} from "./compat/agent-model.js";
export type {
  AgentBatchReduction,
  AgentEventEnvelope,
  AgentEventId,
  AgentEventRouting,
  AgentItem,
  AgentItemId,
  AgentItemKind,
  AgentModelState,
  AgentReducerResult,
  AgentThread,
  AgentThreadActivityState,
  AgentThreadId,
  AgentTurn,
  AgentTurnExecutionId,
  AgentTurnId,
  AgentTurnStatus,
  AgentTurnTrigger,
  CanonicalAgentEvent,
  CanonicalAgentEventEnvelope,
  CollaborationAction,
  CollaborationActionId,
  CollaborationActionKind,
  CollaborationActionStatus,
  CollaborationSource,
  CollaborationTarget,
  IdentityProvenance,
  Provider,
  ProviderCapability,
  ProviderCapabilityName,
  ProviderCapabilitySupport,
  ProviderIdentity,
  ProviderIdentityScope,
} from "./compat/agent-model.js";

// Plan questions
export {
  PlanQuestionOptionSchema,
  PlanQuestionSchema,
  PlanAnswerSchema,
  PlanQuestionBatchSchema,
  PLAN_ANSWER_MESSAGE_PREFIX,
} from "./models/plan-questions.js";
export type {
  PlanQuestionOption,
  PlanQuestion,
  PlanAnswer,
  PlanQuestionBatch,
} from "./models/plan-questions.js";

// Plan output
export {
  PlanSectionSchema,
  PlanSectionNavSchema,
  PlanOutputSchema,
  PlanStatusSchema,
  PlanActionSchema,
  PlanRecordSchema,
} from "./models/plan-output.js";
export type {
  PlanSection,
  PlanSectionNav,
  PlanOutput,
  PlanStatus,
  PlanAction,
  PlanRecord,
} from "./models/plan-output.js";

// Permissions
export {
  PermissionDecisionSchema,
  PermissionRequestSchema,
} from "./models/permission.js";
export type {
  PermissionDecision,
  PermissionRequest,
} from "./models/permission.js";

// Git / GitHub
export { GitBranchSchema, WorktreeSchema, GitCommitSchema, BranchComparisonSchema, GitRemoteUrlSchema } from "./git.js";
export type { GitBranch, WorktreeInfo, GitCommit, BranchComparison, GitRemoteUrl } from "./git.js";

export { PrInfoSchema, PrDetailSchema, PrDraftSchema, CreatePrParamsSchema, CreatePrResultSchema, CheckRunSchema, ChecksStatusSchema } from "./github.js";
export type { PrInfo, PrDetail, PrDraft, CreatePrParams, CreatePrResult, CheckRun, ChecksStatus } from "./github.js";

export {
  PULL_REQUEST_LIST_DEFAULT_LIMIT,
  PULL_REQUEST_LIST_MAX_LIMIT,
  PULL_REQUEST_CURSOR_MAX_LENGTH,
  PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH,
  PULL_REQUEST_SEARCH_MAX_LENGTH,
  PULL_REQUEST_DETAIL_PAGE_DEFAULT_LIMIT,
  PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT,
  PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH,
  PULL_REQUEST_REVIEWERS_MAX,
  PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX,
  PULL_REQUEST_FILE_PAGE_DEFAULT_LIMIT,
  PULL_REQUEST_FILE_PAGE_MAX_LIMIT,
  PULL_REQUEST_FILE_MAX_COUNT,
  PULL_REQUEST_FILE_PATH_MAX_LENGTH,
  PULL_REQUEST_FILE_LOCATOR_MAX_LENGTH,
  PULL_REQUEST_PATCH_MAX_BYTES,
  PULL_REQUEST_PATCH_MAX_LINES,
  PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
  PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH,
  PULL_REQUEST_REVIEW_WORKTREE_NAME_MAX_LENGTH,
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  PULL_REQUEST_REVIEW_DRAFT_MAX_COUNT,
  PULL_REQUEST_REVIEW_DRAFT_TOTAL_MAX_BYTES,
  PullRequestProviderSchema,
  PullRequestOperationIdSchema,
  PullRequestRelationshipSchema,
  PullRequestStateSchema,
  PullRequestReadinessSchema,
  PullRequestIdentitySchema,
  PullRequestActorSchema,
  PullRequestRefSchema,
  PullRequestChecksSummarySchema,
  PullRequestSummarySchema,
  PullRequestCapabilityNameSchema,
  PullRequestCapabilityReasonSchema,
  PullRequestCapabilitySchema,
  PullRequestCapabilitiesSchema,
  PullRequestErrorCodeSchema,
  PullRequestErrorSchema,
  PullRequestCapabilityLimitationSchema,
  PullRequestCapabilitiesRequestSchema,
  PullRequestCapabilitiesResultSchema,
  PullRequestListRequestSchema,
  PullRequestListResultSchema,
  PullRequestFileChangeTypeSchema,
  PullRequestFilePatchStatusSchema,
  PullRequestFileSchema,
  PullRequestFilesRequestSchema,
  PullRequestFilesResultSchema,
  PullRequestPatchRequestSchema,
  PullRequestPatchResultSchema,
  PullRequestBoundedDataReasonSchema,
  PullRequestBoundedDataMarkerSchema,
  PullRequestMergeabilitySchema,
  PullRequestReviewDecisionSchema,
  PullRequestReviewStateSchema,
  PullRequestReviewerTargetSchema,
  PullRequestReviewerSchema,
  PullRequestDetailSchema,
  PullRequestCheckKindSchema,
  PullRequestCheckStateSchema,
  PullRequestCheckSchema,
  PullRequestIssueCommentSchema,
  PullRequestReviewCommentSchema,
  PullRequestDiffSideSchema,
  PullRequestDiffSubjectTypeSchema,
  PullRequestReviewThreadSchema,
  PullRequestConversationItemSchema,
  PullRequestGetResourceSchema,
  PullRequestGetRequestSchema,
  PullRequestGetResultSchema,
  PullRequestTimelineLaneSchema,
  PullRequestTimelineKindSchema,
  PullRequestTimelineItemSchema,
  PullRequestTimelineRequestSchema,
  PullRequestTimelineResultSchema,
  PullRequestCancelRequestSchema,
  PullRequestCancelResultSchema,
  PullRequestWorkspaceCandidateSchema,
  PullRequestReviewSourceSchema,
  PullRequestReviewWorktreeCandidateSchema,
  PullRequestReviewLinkSchema,
  PullRequestCreateReviewTaskRequestSchema,
  PullRequestCreateReviewTaskResultSchema,
  PullRequestReviewLinkRequestSchema,
  PullRequestReviewLinkResultSchema,
  PullRequestMutationExpectedSchema,
  PullRequestMutationConflictReasonSchema,
  PullRequestMutationErrorSchema,
  PullRequestPostCommentRequestSchema,
  PullRequestPostCommentResultSchema,
  PullRequestReviewSubmissionEventSchema,
  PullRequestReviewDraftCoordinateSchema,
  PullRequestReviewDraftSubmissionSchema,
  PullRequestSubmitReviewRequestSchema,
  PullRequestSubmitReviewResultSchema,
  PullRequestSetReadinessRequestSchema,
  PullRequestSetReadinessResultSchema,
  PullRequestCloseRequestSchema,
  PullRequestCloseResultSchema,
  PullRequestMergeMethodSchema,
  PullRequestMergeRequestSchema,
  PullRequestMergeResultSchema,
} from "./pull-requests.js";
export type {
  PullRequestProvider,
  PullRequestOperationId,
  PullRequestRelationship,
  PullRequestState,
  PullRequestReadiness,
  PullRequestIdentity,
  PullRequestActor,
  PullRequestRef,
  PullRequestChecksSummary,
  PullRequestSummary,
  PullRequestCapabilityName,
  PullRequestCapabilityReason,
  PullRequestCapability,
  PullRequestCapabilities,
  PullRequestErrorCode,
  PullRequestError,
  PullRequestCapabilityLimitation,
  PullRequestCapabilitiesRequest,
  PullRequestCapabilitiesResult,
  PullRequestListRequest,
  PullRequestListResult,
  PullRequestFileChangeType,
  PullRequestFilePatchStatus,
  PullRequestFile,
  PullRequestFilesRequest,
  PullRequestFilesResult,
  PullRequestPatchRequest,
  PullRequestPatchResult,
  PullRequestBoundedDataReason,
  PullRequestBoundedDataMarker,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestReviewState,
  PullRequestReviewerTarget,
  PullRequestReviewer,
  PullRequestDetail,
  PullRequestCheckKind,
  PullRequestCheckState,
  PullRequestCheck,
  PullRequestIssueComment,
  PullRequestReviewComment,
  PullRequestDiffSide,
  PullRequestDiffSubjectType,
  PullRequestReviewThread,
  PullRequestConversationItem,
  PullRequestGetResource,
  PullRequestGetRequest,
  PullRequestGetResult,
  PullRequestTimelineLane,
  PullRequestTimelineKind,
  PullRequestTimelineItem,
  PullRequestTimelineRequest,
  PullRequestTimelineResult,
  PullRequestCancelRequest,
  PullRequestCancelResult,
  PullRequestWorkspaceCandidate,
  PullRequestReviewSource,
  PullRequestReviewWorktreeCandidate,
  PullRequestReviewLink,
  PullRequestCreateReviewTaskRequest,
  PullRequestCreateReviewTaskResult,
  PullRequestReviewLinkRequest,
  PullRequestReviewLinkResult,
  PullRequestMutationExpected,
  PullRequestMutationConflictReason,
  PullRequestMutationError,
  PullRequestPostCommentRequest,
  PullRequestPostCommentResult,
  PullRequestReviewSubmissionEvent,
  PullRequestReviewDraftCoordinate,
  PullRequestReviewDraftSubmission,
  PullRequestSubmitReviewRequest,
  PullRequestSubmitReviewResult,
  PullRequestSetReadinessRequest,
  PullRequestSetReadinessResult,
  PullRequestCloseRequest,
  PullRequestCloseResult,
  PullRequestMergeMethod,
  PullRequestMergeRequest,
  PullRequestMergeResult,
} from "./pull-requests.js";

// Skills
export {
  SkillInfoSchema,
  SkillKindSchema,
  SkillSourceSchema,
  SkillDiagnosticsSchema,
} from "./skills.js";
export type {
  SkillInfo,
  SkillKind,
  SkillSource,
  SkillDiagnostics,
} from "./skills.js";

// Provider capability catalogs
export {
  PROVIDER_CATALOG_PATH_MAX_CHARS,
  PROVIDER_CATALOG_MAX_ENTRIES,
  PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS,
  PROVIDER_CATALOG_MAX_DIAGNOSTICS,
  PROVIDER_CATALOG_MAX_CODEX_AGENT_FILES,
  PROVIDER_CATALOG_MAX_CODEX_AGENT_FILE_BYTES,
  ProviderCapabilityKindSchema,
  ProviderSkillCapabilitySchema,
  ProviderPluginCapabilitySchema,
  ProviderCustomPromptCapabilitySchema,
  ProviderCommandCapabilitySchema,
  ProviderCapabilityEntrySchema,
  SelectableProviderAgentSchema,
  ProviderCatalogDiagnosticSourceKindSchema,
  ProviderCatalogSourceDiagnosticSchema,
  ProviderCatalogDiagnosticSchema,
  ProviderCatalogFreshnessSchema,
  ProviderCatalogContextSchema,
  ProviderCatalogRequestSchema,
  ProviderCatalogSnapshotSchema,
  ProviderCapabilityIdentitySchema,
  SelectableProviderAgentChangesSchema,
  ProviderCatalogChangeSchema,
} from "./providers/capability-catalog.js";
export type {
  ProviderCapabilityKind,
  ProviderPluginCapability,
  ProviderCapabilityEntry,
  SelectableProviderAgent,
  ProviderCatalogDiagnosticSourceKind,
  ProviderCatalogSourceDiagnostic,
  ProviderCatalogDiagnostic,
  ProviderCatalogFreshness,
  ProviderCatalogContext,
  ProviderCatalogRequest,
  ProviderCatalogSnapshot,
  ProviderCapabilityIdentity,
  SelectableProviderAgentChanges,
  ProviderCatalogChange,
} from "./providers/capability-catalog.js";

// WebSocket protocol
export {
  WebSocketRequestSchema,
  WebSocketResponseSchema,
  WsPushSchema,
  BinaryUploadHeaderSchema,
} from "./ws/protocol.js";
export type {
  WebSocketRequest,
  WebSocketResponse,
  WsPush,
  BinaryUploadHeader,
} from "./ws/protocol.js";

export {
  WS_METHODS,
  CreateThreadSchema,
  SendMessageSchema,
  CreateAndSendSchema,
  CreateAndSendResultSchema,
  RECAP_MAX_MESSAGES,
  RECAP_MAX_MESSAGE_CONTENT_CHARS,
  RECAP_MAX_PREVIOUS_RECAP_CHARS,
  MAX_THREAD_SUBSCRIPTIONS,
  SetThreadSubscriptionsSchema,
  SetThreadSubscriptionsResultSchema,
} from "./ws/methods.js";
export type {
  WsMethodName,
  SendMessageInput,
  CreateAndSendInput,
  CreateAndSendResult,
  SetThreadSubscriptionsInput,
  SetThreadSubscriptionsResult,
} from "./ws/methods.js";

export { CANONICAL_AGENT_EVENT_BATCH_MAX, WS_CHANNELS } from "./ws/channels.js";
export type { WsChannelName } from "./ws/channels.js";
export { TerminalBackendCapabilitiesSchema } from "./models/terminal-backend.js";
export type { TerminalBackendCapabilities } from "./models/terminal-backend.js";

export {
  TERMINAL_CONTRACT_VERSION,
  TERMINAL_U64_MAX,
  TERMINAL_MAX_PAYLOAD_BYTES,
  TERMINAL_MAX_CHECKPOINT_BYTES,
  TERMINAL_MAX_SESSIONS,
  TERMINAL_DEFAULT_SESSION_LIMIT,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TerminalUuidSchema,
  TerminalU64Schema,
  TerminalTimestampSchema,
  TerminalPlatformSchema,
  TerminalProfileNameSchema,
  TerminalExecutableSchema,
  TerminalProfileArgumentsSchema,
  TerminalScopeSchema,
  TerminalSessionStateSchema,
  TerminalCertifiedProfileIdSchema,
  TerminalCustomProfileIdSchema,
  TerminalProfileReferenceSchema,
  TerminalResolvedProfileSchema,
  TerminalCustomProfileSchema,
  TerminalLaunchSnapshotSchema,
  TerminalExitMetadataSchema,
  TerminalSessionSnapshotSchema,
  TerminalAttachmentDescriptorSchema,
  TerminalGapSchema,
  TerminalHydrationDescriptorSchema,
  TerminalErrorCodeSchema,
  TerminalRetryClassSchema,
  TerminalProfileInUseDataSchema,
  TerminalErrorSchema,
  TerminalV1BackendCapabilitiesSchema,
} from "./models/terminal.js";
export type {
  TerminalScope,
  TerminalPlatform,
  TerminalSessionState,
  TerminalProfileReference,
  TerminalResolvedProfile,
  TerminalCustomProfile,
  TerminalLaunchSnapshot,
  TerminalExitMetadata,
  TerminalSessionSnapshot,
  TerminalAttachmentDescriptor,
  TerminalGap,
  TerminalHydrationDescriptor,
  TerminalErrorCode,
  TerminalRetryClass,
  TerminalProfileInUseData,
  TerminalError,
  TerminalV1BackendCapabilities,
} from "./models/terminal.js";

export {
  TERMINAL_MAX_EXECUTABLE_TRACE_STEPS,
  TERMINAL_BOOT_TRANSITIONS,
  TERMINAL_SESSION_TRANSITIONS,
  TERMINAL_HOST_HEALTH_TRANSITIONS,
  TERMINAL_ATTACHMENT_TRANSITIONS,
  TERMINAL_HYDRATION_DECISIONS,
  TERMINAL_TOMBSTONE_TRANSITIONS,
  TERMINAL_CHECKPOINT_TRANSITIONS,
  TERMINAL_SEQUENCE_TRACES,
  executeTerminalSequenceTrace,
  executeTerminalTransitionTrace,
  resolveTerminalSessionTransition,
} from "./models/terminal-lifecycle.js";
export type {
  TerminalSequenceTraceAction,
  TerminalSequenceTraceName,
  TerminalTransition,
  TerminalBootState,
  TerminalHostHealthState,
  TerminalAttachmentState,
  TerminalTombstoneState,
  TerminalCheckpointState,
} from "./models/terminal-lifecycle.js";

export {
  TERMINAL_SETTINGS_SCHEMA_VERSION,
  TERMINAL_MIN_SCROLLBACK_LINES,
  TERMINAL_MAX_SCROLLBACK_LINES,
  TERMINAL_DEFAULT_SCROLLBACK_LINES,
  TERMINAL_DEFAULT_FONT_FAMILY,
  TerminalPresentationSettingsSchema,
  TerminalBehaviorSettingsSchema,
  TerminalAccessibilitySettingsSchema,
  TerminalFlowControlSettingsSchema,
  TerminalSettingsSchema,
  TerminalSettingsDocumentSchema,
  WorkspaceTerminalPreferenceSchema,
  TerminalProfileRecoverySchema,
  TerminalPreferencesUpdateSchema,
  migrateLegacyTerminalScrollback,
  getDefaultTerminalSettingsDocument,
} from "./models/terminal-settings.js";
export type {
  TerminalSettingsDocument,
  TerminalSettings,
  WorkspaceTerminalPreference,
  TerminalProfileRecovery,
  TerminalPreferencesUpdate,
} from "./models/terminal-settings.js";

export {
  TerminalMetricIdSchema,
  TerminalHealthSnapshotSchema,
  TerminalDiagnosticEventSchema,
  TerminalDiagnosticCounterSchema,
  TerminalDiagnosticHistogramSchema,
  TerminalDiagnosticsBundleSchema,
  TerminalPackagedArtifactAttestationSchema,
  TerminalArtifactAttestationSchema,
  TerminalReleaseArtifactSchema,
  TerminalReleaseSignatureCheckSchema,
  TerminalTargetEvidenceManifestSchema,
  TerminalTargetEvidenceReferenceSchema,
  TerminalReleaseEvidenceManifestSchema,
} from "./models/terminal-diagnostics.js";
export type {
  TerminalMetricId,
  TerminalHealthSnapshot,
  TerminalDiagnosticEvent,
  TerminalDiagnosticsBundle,
  TerminalTargetEvidenceManifest,
  TerminalReleaseEvidenceManifest,
} from "./models/terminal-diagnostics.js";

export {
  TERMINAL_RPC_MAX_BYTES,
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  TERMINAL_CHECKPOINT_EXPIRES_AFTER_MS,
  TERMINAL_V1_METHOD_NAMES,
  TERMINAL_V1_METHODS,
  TerminalRpcRequestSchema,
  parseTerminalRpcRequest,
  TerminalRpcResponseSchema,
} from "./ws/terminal.js";
export type { TerminalV1MethodName } from "./ws/terminal.js";

export {
  TERMINAL_BINARY_MAGIC,
  TERMINAL_BINARY_HEADER_BYTES,
  TERMINAL_BINARY_MAX_FRAME_BYTES,
  TERMINAL_BINARY_FRAME_KINDS,
  encodeTerminalFrame,
  decodeTerminalFrame,
} from "./ws/terminal-binary.js";
export type {
  TerminalBinaryFrameKind,
  TerminalBinaryFrame,
} from "./ws/terminal-binary.js";

export {
  TERMINAL_DATA_TAG,
  encodeTerminalDataFrame,
  decodeTerminalDataFrame,
} from "./ws/terminal-legacy-binary.js";
export type { TerminalDataFrame } from "./ws/terminal-legacy-binary.js";

// Utilities
export { lazySchema } from "./utils/lazySchema.js";

// Handoff contract
export { HANDOFF_MARKER, parseHandoffJson } from "./handoff.js";
export type { HandoffMetadata } from "./handoff.js";

// Provider interfaces
export type {
  ProviderId,
  SessionForkBehavior,
  IAgentProvider,
  IChildTurnCancellable,
  ICompletionCapable,
  IGoalCapable,
  ISessionEvictable,
  IProviderRegistry,
  TurnRequest,
  ProviderOptionsByProvider,
  CompletionOptions,
  ProviderFileMutationStart,
} from "./providers/interfaces.js";

export * from "./providers/catalog.js";
export * from "./providers/availability.js";
export { CURSOR_STATIC_MODEL_FALLBACK } from "./providers/cursor-static-fallback.js";
export { CURSOR_CLI_MODEL_SNAPSHOT } from "./providers/cursor-cli-models-snapshot.js";
export { CODEX_STATIC_MODELS, supportsCodexUltraOrchestration } from "./providers/codex-static-fallback.js";
export { CLAUDE_STATIC_MODELS } from "./providers/claude-static-fallback.js";

export {
  ProviderModelInfoSchema,
  ModelPolicyStateSchema,
} from "./providers/models.js";
export type { ProviderModelInfo } from "./providers/models.js";
export {
  isChildTurnCancellable,
  isCompletionCapable,
  isGoalCapable,
  isSessionEvictable,
} from "./providers/interfaces.js";

export type {
  SessionForker,
  ForkRequest,
  HandoffArtifact,
  HandoffMeta,
  HandoffMode,
  LadderStep,
  ForkAnchorRole,
  ForkHistoryBudget,
  ProviderErrorClass,
} from "./providers/session-forker.js";

export {
  TurnUsageSchema,
  QuotaCategorySchema,
  ProviderBillingModeSchema,
  ProviderUsageInfoSchema,
} from "./providers/usage.js";
export type {
  TurnUsage,
  QuotaCategory,
  ProviderBillingMode,
  ProviderUsageInfo,
} from "./providers/usage.js";

export { CopilotSubagentSchema } from "./providers/copilot-agent.js";
export type { CopilotSubagent } from "./providers/copilot-agent.js";
