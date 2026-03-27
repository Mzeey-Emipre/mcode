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

export { MessageSchema } from "./models/message.js";
export type { Message } from "./models/message.js";

// Events
export { AgentEventSchema } from "./events/agent-event.js";
export type { AgentEvent } from "./events/agent-event.js";

// Git / GitHub
export { GitBranchSchema, WorktreeSchema } from "./git.js";
export type { GitBranch, WorktreeInfo } from "./git.js";

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
} from "./ws/protocol.js";
export type {
  WebSocketRequest,
  WebSocketResponse,
  WsPush,
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

// Provider interfaces
export type {
  ProviderId,
  IAgentProvider,
  IProviderRegistry,
} from "./providers/interfaces.js";
