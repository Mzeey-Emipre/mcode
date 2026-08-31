/**
 * Pure helpers that translate between mcode's PermissionDecision contract
 * and the codex app-server's per-method approval response shapes.
 *
 * No I/O, no logger side effects here beyond a single warn on unknown method
 * names. Keep this module free of CodexAppServer or CodexProvider imports so
 * both the supervised path and the CodexAppServer safe-deny fallback can share
 * one implementation.
 */

import { logger } from "@mcode/shared";
import type { PermissionDecision, PermissionRequest } from "@mcode/contracts";

/**
 * Method names emitted by the codex app-server when it needs host approval.
 * Source: codex-rs/app-server-protocol/schema/json/*ApprovalResponse.json
 * in https://github.com/openai/codex
 */
export const CODEX_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

/** Record type for the params field the codex app-server hands us on a serverRequest. */
export type CodexApprovalParams = Record<string, unknown>;

const COMMAND_APPROVAL_BY_DECISION: Record<PermissionDecision, string> = {
  allow: "accept",
  "allow-session": "acceptForSession",
  deny: "decline",
  cancelled: "cancel",
};
const LEGACY_APPROVAL_BY_DECISION: Record<PermissionDecision, string> = {
  allow: "approved",
  "allow-session": "approved_for_session",
  deny: "denied",
  cancelled: "abort",
};
const SESSION_PERMISSION_DECISIONS = new Set<PermissionDecision>(["allow-session"]);
const GRANTED_PERMISSION_DECISIONS = new Set<PermissionDecision>(["allow", "allow-session"]);
const COMMAND_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const LEGACY_APPROVAL_METHODS = new Set(["applyPatchApproval", "execCommandApproval"]);

/**
 * Translate a PermissionDecision into the response payload the codex app-server
 * expects for a given approval method.
 *
 * Design locked in spec Section 2. The cancelled decision uses cancel/abort so
 * the turn interrupts immediately, matching the user intent behind stopSession.
 * The permissions method has no native cancel variant in the schema so cancelled
 * degrades to the deny shape; the turn still interrupts because CodexProvider
 * calls kill() (which sends turn/interrupt) right after draining.
 */
export function mapDecisionToCodexResponse(
  method: string,
  decision: PermissionDecision,
  params: CodexApprovalParams,
): unknown {
  if (COMMAND_APPROVAL_METHODS.has(method)) return { decision: COMMAND_APPROVAL_BY_DECISION[decision] };
  if (method === "item/permissions/requestApproval") {
    return permissionApprovalResponse(decision, params);
  }
  if (LEGACY_APPROVAL_METHODS.has(method)) return { decision: LEGACY_APPROVAL_BY_DECISION[decision] };
  logger.warn("Codex approval: unknown method, falling back to safe-deny default", { method });
  if (method.toLowerCase().includes("permissions")) return { permissions: {}, scope: "turn" };
  return { decision: "decline" };
}

function permissionApprovalResponse(
  decision: PermissionDecision,
  params: CodexApprovalParams,
): { permissions: unknown; scope: "turn" | "session" } {
  return {
    permissions: GRANTED_PERMISSION_DECISIONS.has(decision) ? params.permissions ?? {} : {},
    scope: SESSION_PERMISSION_DECISIONS.has(decision) ? "session" : "turn",
  };
}

/**
 * Input shape for synthesizeCodexPermissionRequest. threadId is the mcode
 * thread UUID (not the codex threadId), so the UI can locate the card under
 * the right mcode thread.
 */
export interface SynthesizeInput {
  threadId: string;
  requestId: string;
  method: string;
  params: CodexApprovalParams;
}

/**
 * Build a PermissionRequest (Phase 1 contract) from a codex serverRequest
 * payload. toolName choices documented in spec Section 3.
 */
export function synthesizeCodexPermissionRequest(in_: SynthesizeInput): PermissionRequest {
  const { threadId, requestId, method, params } = in_;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const title = reason;

  if (method === "item/commandExecution/requestApproval") {
    const input: Record<string, unknown> = {
      command: params.command,
      cwd: params.cwd,
    };
    if (params.commandActions !== undefined) input.commandActions = params.commandActions;
    if (params.networkApprovalContext !== undefined) {
      input.networkApprovalContext = params.networkApprovalContext;
    }
    return { requestId, threadId, toolName: "Shell", input, title };
  }

  if (method === "item/fileChange/requestApproval") {
    const input: Record<string, unknown> = { itemId: params.itemId };
    if (params.grantRoot !== undefined) input.grantRoot = params.grantRoot;
    return { requestId, threadId, toolName: "FileWrite", input, title };
  }

  if (method === "item/permissions/requestApproval") {
    return {
      requestId,
      threadId,
      toolName: "WorkspacePermissions",
      input: { permissions: params.permissions },
      title,
    };
  }

  if (method === "applyPatchApproval") {
    return { requestId, threadId, toolName: "ApplyPatch", input: params, title };
  }

  // execCommandApproval (legacy) and any future method name: pass-through.
  return { requestId, threadId, toolName: "Shell", input: params, title };
}
