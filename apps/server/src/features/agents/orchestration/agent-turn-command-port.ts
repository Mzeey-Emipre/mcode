import type {
  AttachmentMeta,
  ContextWindowMode,
  PermissionMode,
  ProviderId,
  ReasoningLevel,
  StoredAttachment,
  TurnRuntimeSnapshot,
} from "@mcode/contracts";

/** The narrow execution command surface available to feature-owned turn flows. */
export class AgentTurnCommandPort {
  constructor(private readonly runtime: AgentRuntimeCommandPort) {}

  /** Dispatch one focused feature turn through the runtime owner. */
  sendMessage(command: AgentTurnCommand): Promise<void> {
    return this.runtime.sendMessage(command);
  }
  /** Read authoritative runtime snapshots without exposing mutable state. */
  runtimeSnapshots(): TurnRuntimeSnapshot[] {
    return this.runtime.runtimeSnapshots();
  }
}

/** The private runtime operations that a command dispatcher needs from its owner. */
interface AgentRuntimeCommandTarget {
  sendMessage(command: AgentTurnCommand): Promise<void>;
  runtimeSnapshots(): TurnRuntimeSnapshot[];
}

/** Bridges feature-owned commands to the runtime owner without a reverse DI dependency. */
export class AgentRuntimeCommandPort {
  private target: AgentRuntimeCommandTarget | undefined;

  /** Bind the single runtime owner during server composition. */
  bind(target: AgentRuntimeCommandTarget): void {
    this.target = target;
  }

  /** Dispatch one feature-owned command. */
  sendMessage(command: AgentTurnCommand): Promise<void> {
    return this.requireTarget().sendMessage(command);
  }

  /** Read runtime snapshots for focused feature decisions. */
  runtimeSnapshots(): TurnRuntimeSnapshot[] {
    return this.requireTarget().runtimeSnapshots();
  }

  private requireTarget(): AgentRuntimeCommandTarget {
    if (!this.target) throw new Error("Agent runtime command port is not configured");
    return this.target;
  }
}

/** A provider turn requested by a focused feature owner. */
export interface AgentTurnCommand {
  threadId: string;
  content: string;
  permissionMode?: PermissionMode | "default";
  model: string;
  attachments: AttachmentMeta[];
  reasoningLevel?: ReasoningLevel;
  provider?: ProviderId;
  contextWindow?: ContextWindowMode;
  thinking?: boolean;
  markPlanAnswerForMessageId?: string;
  persistedAttachmentData?: {
    readonly stored: readonly StoredAttachment[];
    readonly persisted: readonly AttachmentMeta[];
  };
  cleanupPersistedAttachmentsOnHandledCommand?: boolean;
}

/** Injection token for the provider-turn command facade. */
export const AGENT_TURN_COMMAND_PORT = AgentTurnCommandPort;
