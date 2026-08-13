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
  if (
    method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
  ) {
    switch (decision) {
      case "allow": return { decision: "accept" };
      case "allow-session": return { decision: "acceptForSession" };
      case "deny": return { decision: "decline" };
      case "cancelled": return { decision: "cancel" };
    }
  }

  if (method === "item/permissions/requestApproval") {
    const echoed = (params.permissions as unknown) ?? {};
    switch (decision) {
      case "allow": return { permissions: echoed, scope: "turn" };
      case "allow-session": return { permissions: echoed, scope: "session" };
      case "deny": return { permissions: {}, scope: "turn" };
      case "cancelled": return { permissions: {}, scope: "turn" };
    }
  }

  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    switch (decision) {
      case "allow": return { decision: "approved" };
      case "allow-session": return { decision: "approved_for_session" };
      case "deny": return { decision: "denied" };
      case "cancelled": return { decision: "abort" };
    }
  }

  // Unknown method: pick the safer default shape based on whether the name
  // looks permissions-like, and warn so schema drift shows up in logs.
  logger.warn("Codex approval: unknown method, falling back to safe-deny default", { method });
  if (method.toLowerCase().includes("permissions")) {
    return { permissions: {}, scope: "turn" };
  }
  return { decision: "decline" };
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
