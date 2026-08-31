import type * as NodeChildProcess from "node:child_process";
import type {
  Client,
  ClientSideConnection,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

/** Package-private child-process launch details for an ACP agent. */
export type AcpSpawnSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  shell?: boolean;
};

/** Inputs used when opening one logical ACP session. */
export type AcpSessionOpenInput = {
  resumeFrom?: string;
  cwd: string;
  mcpServers: readonly McpServer[];
};

/** Generic permission request surfaced by an ACP agent. */
export type AcpPermissionRequest = RequestPermissionRequest;

/** Generic permission result returned to an ACP agent. */
export type AcpPermissionOutcome = RequestPermissionResponse;

/** Normalized ACP session update. */
export type AcpSessionUpdate = SessionNotification;

/** Provider callbacks used to adapt ACP requests and notifications. */
export type AcpSessionCallbacks = {
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
  onSessionUpdate: (update: AcpSessionUpdate) => Promise<void>;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  onExtensionRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExtensionNotification?: (method: string, params: unknown) => Promise<void>;
};

/** Protocol-level state for one ACP child and logical session. */
export type AcpSessionState = {
  child: NodeChildProcess.ChildProcess;
  connection: ClientSideConnection;
  sessionId: string;
  agentCapabilities: unknown;
  activePrompt: Promise<unknown> | null;
};

/** Factory for the ACP client request handlers. */
export type AcpClientFactory = (callbacks: AcpSessionCallbacks) => Client;
