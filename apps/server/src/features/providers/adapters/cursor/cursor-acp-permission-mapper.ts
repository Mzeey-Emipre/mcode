/**
 * Bridges ACP `requestPermission` payloads to mcode {@link PermissionRequest} and back.
 */

import type { PermissionOption, RequestPermissionOutcome } from "@agentclientprotocol/sdk";
import type { PermissionDecision, PermissionRequest } from "@mcode/contracts";

/**
 * Builds a pending permission card for the web client from an ACP request.
 *
 * @param input - Stable `requestId` from the provider plus ACP payload fields.
 */
export function synthesizeCursorAcpPermissionRequest(input: {
  requestId: string;
  threadId: string;
  toolTitle: string;
  rawToolInput: unknown;
}): PermissionRequest {
  const { requestId, threadId, toolTitle, rawToolInput } = input;
  const toolInput =
    rawToolInput !== undefined && typeof rawToolInput === "object" && !Array.isArray(rawToolInput)
      ? (rawToolInput as Record<string, unknown>)
      : {};
  return {
    requestId,
    threadId,
    toolName: toolTitle || "Tool",
    input: toolInput,
    title: toolTitle || undefined,
  };
}

/** Picks the first allow-style option Cursor offered (full-access auto-approve). */
export function pickFullAccessAllowOption(options: PermissionOption[]): string | undefined {
  const ranked = ["allow_always", "allow_once"] as const;
  for (const kind of ranked) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  return options[0]?.optionId;
}

/**
 * Maps an mcode user decision onto an ACP {@link RequestPermissionOutcome}.
 *
 * Prefer option kinds that match the intent; fallback to `options[0]` so a host
 * misconfiguration cannot wedge the prompt turn indefinitely.
 */
export function mapDecisionToAcpOutcome(
  decision: PermissionDecision,
  options: PermissionOption[],
): RequestPermissionOutcome {
  if (decision === "cancelled") {
    return { outcome: "cancelled" };
  }
  const pickKind = (kinds: readonly PermissionOption["kind"][]): string | undefined => {
    for (const kind of kinds) {
      const hit = options.find((o) => o.kind === kind);
      if (hit) return hit.optionId;
    }
    return undefined;
  };

  let optionId: string | undefined;
  if (decision === "allow") {
    optionId = pickKind(["allow_once", "allow_always"]);
  } else if (decision === "allow-session") {
    optionId = pickKind(["allow_always", "allow_once"]);
  } else {
    optionId = pickKind(["reject_once", "reject_always"]);
  }
  const resolved = optionId ?? options[0]?.optionId;
  if (!resolved) {
    return { outcome: "cancelled" };
  }
  return { outcome: "selected", optionId: resolved };
}
