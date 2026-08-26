import type { ChildProcess } from "node:child_process";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type {
  ProviderBrowserCredentialMetadata,
  ProviderBrowserLeaseGrant,
  ProviderBrowserLeaseHandle,
} from "../../host-ports.js";
import type { AcpSessionRuntime } from "../protocols/acp/acp-session-runtime.js";
import type { CursorAcpTurnState } from "./acp/cursor-acp-event-mapper.js";
import type { CursorTodoSnapshot } from "./events/cursor-todo-snapshot.js";

/** Describes browser credentials attached to one Cursor session. */
export type CursorBrowserCredentialMetadata = ProviderBrowserCredentialMetadata;

/** Describes a browser grant retained while Cursor replaces a session. */
export type CursorBrowserLeaseGrant = ProviderBrowserLeaseGrant;

/** Describes a browser lease staged before Cursor starts a session. */
export type CursorBrowserLeaseHandle = ProviderBrowserLeaseHandle;

/** Stores the mutable state for one long-lived Cursor ACP session. */
export interface CursorAcpSessionEntry {
  mcodeSessionId: string;
  threadId: string;
  child: ChildProcess;
  connection: ClientSideConnection;
  acpRuntime: AcpSessionRuntime;
  acpSessionId: string;
  cwd: string;
  permissionMode: "full" | "default";
  lastUsedAt: number;
  todoSnapshot: CursorTodoSnapshot;
  turnChain: Promise<void>;
  activeTurnState: CursorAcpTurnState | null;
  stickyHeavyInstructionsSent: boolean;
  cursorPromptOrdinal: number;
  stderrTailLines: string[];
  cursorModelAppliedPair: { acpSessionId: string; modelId: string } | null;
  pendingUserStopAbort: boolean;
  browserHttpMcpSupported: boolean;
  browserCredential?: CursorBrowserCredentialMetadata & { leaseId: string };
  workspaceId: string;
  browserPermissionCapability: "observe" | "interact" | "privileged";
  supportsHttpMcp: boolean;
  threadControlMcpEnabled: boolean;
  mcodeRuntimeInstructions: string;
  mcodeRuntimeInstructionsSent: boolean;
  mcodeLogicalSessionReloaded: boolean;
}

/** Identifies a state entry owned by the shared session runtime. */
export type CursorSessionState = CursorAcpSessionEntry;

/** Captures the browser scope that must stay fixed for one Cursor process. */
export type CursorBrowserContext = Pick<
  CursorAcpSessionEntry,
  "workspaceId" | "browserPermissionCapability"
>;
