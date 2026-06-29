// Models
export {
  ThreadStatusSchema,
  ThreadModeSchema,
  MessageRoleSchema,
  PermissionModeSchema,
  PERMISSION_MODES,
  InteractionModeSchema,
  INTERACTION_MODES,
  CopilotSubagentSourceSchema,
  COPILOT_SUBAGENT_SOURCES,
} from "./models/enums.js";
export type {
  ThreadStatus,
  ThreadMode,
  MessageRole,
  PermissionMode,
  InteractionMode,
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
  MCODE_WORKSPACE_PREVIEW_PROTOCOL,
  isMcodeWorkspacePreviewUrl,
  mcodeWorkspacePreviewHref,
  markdownWorkspaceRefToPreviewPath,
  looksLikeWorkspaceRelativeFileRef,
} from "./models/workspace-preview-uri.js";

export { ThreadSchema, RecentThreadSchema, ThreadCheckoutStateSchema } from "./models/thread.js";
export type { Thread, RecentThread, ThreadCheckoutState } from "./models/thread.js";

export { MessageSchema, PaginatedMessagesSchema } from "./models/message.js";
export type { Message, PaginatedMessages } from "./models/message.js";

export {
  MessageMentionSchema,
  MessageMentionsSchema,
  MAX_MESSAGE_MENTIONS,
} from "./models/mention.js";
export type { MessageMention } from "./models/mention.js";

export {
  GoalControlsSchema,
  GoalLookupReasonSchema,
  GoalLookupResultSchema,
  GoalLookupSourceSchema,
  GoalStateSchema,
  GoalStatusSchema,
  isGoalOpen,
  isGoalStatusOpen,
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
  ToolCallRecordSchema,
  ToolCallStatusSchema,
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
  BrowserPreviewBoundsSchema,
  BrowserPreviewCaptureKindSchema,
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
  isBrowserCaptureSpillAppDataPath,
  clampMcodeBrowserCaptureV2,
  clampAttachedBrowserCaptureForOutbound,
} from "./models/browser-preview.js";
export type {
  BrowserPreviewBounds,
  BrowserPreviewCaptureKind,
  McodeBrowserCaptureV1,
  AttachedBrowserCaptureV1,
  McodeBrowserCaptureV2,
  AttachedBrowserCaptureV2,
  McodeBrowserCapture,
  AttachedBrowserCapture,
  BrowserCaptureSpillFile,
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
  BROWSER_USE_FRAME_HEADER_BYTES,
  BROWSER_USE_MAX_MESSAGE_BYTES,
  BROWSER_USE_METHODS,
  MCODE_BROWSER_USE_PIPE_ENV,
  DPCODE_BROWSER_USE_PIPE_ENV,
  T3CODE_BROWSER_USE_PIPE_ENV,
  BrowserUseTabRowSchema,
  BrowserExecuteCdpInputSchema,
  BrowserUseCdpNotificationParamsSchema,
} from "./models/browser-use.js";
export type {
  BrowserUseMethod,
  BrowserUseTabRow,
  BrowserExecuteCdpInput,
  BrowserUseCdpNotificationParams,
} from "./models/browser-use.js";

// Events
export { AgentEventSchema, AgentEventType } from "./events/agent-event.js";
export type { AgentEvent } from "./events/agent-event.js";

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
} from "./ws/methods.js";
export type { WsMethodName, CreateAndSendResult } from "./ws/methods.js";

export { WS_CHANNELS } from "./ws/channels.js";
export type { WsChannelName } from "./ws/channels.js";

export {
  TERMINAL_DATA_TAG,
  encodeTerminalDataFrame,
  decodeTerminalDataFrame,
} from "./ws/terminal-binary.js";
export type { TerminalDataFrame } from "./ws/terminal-binary.js";

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
  ICompletionCapable,
  IGoalCapable,
  ISkillCatalogCapable,
  ISessionEvictable,
  IProviderRegistry,
  TurnRequest,
  ProviderOptionsByProvider,
  CompletionOptions,
} from "./providers/interfaces.js";

export * from "./providers/catalog.js";
export * from "./providers/availability.js";
export { CURSOR_STATIC_MODEL_FALLBACK } from "./providers/cursor-static-fallback.js";
export { CURSOR_CLI_MODEL_SNAPSHOT } from "./providers/cursor-cli-models-snapshot.js";
export { CODEX_STATIC_MODELS } from "./providers/codex-static-fallback.js";

export {
  ProviderModelInfoSchema,
  ModelPolicyStateSchema,
} from "./providers/models.js";
export type { ProviderModelInfo } from "./providers/models.js";
export { isCompletionCapable, isGoalCapable, isSessionEvictable, isSkillCatalogCapable } from "./providers/interfaces.js";

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
  ProviderUsageInfoSchema,
} from "./providers/usage.js";
export type {
  TurnUsage,
  QuotaCategory,
  ProviderUsageInfo,
} from "./providers/usage.js";

export { CopilotSubagentSchema } from "./providers/copilot-agent.js";
export type { CopilotSubagent } from "./providers/copilot-agent.js";
