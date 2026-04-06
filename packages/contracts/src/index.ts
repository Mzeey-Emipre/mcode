// Models
export {
  ThreadStatusSchema,
  ThreadModeSchema,
  MessageRoleSchema,
  PermissionModeSchema,
  PERMISSION_MODES,
  InteractionModeSchema,
  INTERACTION_MODES,
} from "./models/enums.js";
export type {
  ThreadStatus,
  ThreadMode,
  MessageRole,
  PermissionMode,
  InteractionMode,
} from "./models/enums.js";

export {
  AttachmentMetaSchema,
  StoredAttachmentSchema,
} from "./models/attachment.js";
export type { AttachmentMeta, StoredAttachment } from "./models/attachment.js";

export { WorkspaceSchema } from "./models/workspace.js";
export type { Workspace } from "./models/workspace.js";

export { ThreadSchema } from "./models/thread.js";
export type { Thread } from "./models/thread.js";

export { MessageSchema, PaginatedMessagesSchema } from "./models/message.js";
export type { Message, PaginatedMessages } from "./models/message.js";

export {
  ToolCallRecordSchema,
  ToolCallStatusSchema,
} from "./models/tool-call-record.js";
export type {
  ToolCallRecord,
  ToolCallStatus,
} from "./models/tool-call-record.js";

export { TurnSnapshotSchema } from "./models/turn-snapshot.js";
export type { TurnSnapshot } from "./models/turn-snapshot.js";

export {
  SettingsSchema,
  PartialSettingsSchema,
  getDefaultSettings,
  ThemeSchema,
  AgentDefaultModeSchema,
  ReasoningLevelSchema,
  ProviderIdSchema,
  NamingModeSchema,
} from "./models/settings.js";
export type {
  Settings,
  PartialSettings,
  Theme,
  AgentDefaultMode,
  ReasoningLevel,
  SettingsProviderId,
  NamingMode,
} from "./models/settings.js";

export {
  classifyFile,
  isFileSupported,
  getMaxFileSize,
  getExtension,
  inferMimeType,
  MAX_ATTACHMENTS,
  SUPPORTED_EXTENSIONS,
} from "./models/file-types.js";
export type { FileCategory } from "./models/file-types.js";

// Events
export { AgentEventSchema } from "./events/agent-event.js";
export type { AgentEvent } from "./events/agent-event.js";

// Plan questions
export {
  PlanQuestionOptionSchema,
  PlanQuestionSchema,
  PlanAnswerSchema,
  PlanQuestionBatchSchema,
} from "./models/plan-questions.js";
export type {
  PlanQuestionOption,
  PlanQuestion,
  PlanAnswer,
  PlanQuestionBatch,
} from "./models/plan-questions.js";

// Git / GitHub
export { GitBranchSchema, WorktreeSchema, GitCommitSchema } from "./git.js";
export type { GitBranch, WorktreeInfo, GitCommit } from "./git.js";

export { PrInfoSchema, PrDetailSchema } from "./github.js";
export type { PrInfo, PrDetail } from "./github.js";

// Skills
export { SkillInfoSchema } from "./skills.js";
export type { SkillInfo } from "./skills.js";

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
} from "./ws/methods.js";
export type { WsMethodName } from "./ws/methods.js";

export { WS_CHANNELS } from "./ws/channels.js";
export type { WsChannelName } from "./ws/channels.js";

// Utilities
export { lazySchema } from "./utils/lazySchema.js";

// Provider interfaces
export type {
  ProviderId,
  IAgentProvider,
  IProviderRegistry,
} from "./providers/interfaces.js";
