import { z } from "zod";

import { TurnOutcomeSchema } from "../models/turn-outcome.js";
import { AgentEventSchema, type AgentEvent } from "./agent-event.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Native Codex evidence used to route a private child interaction. */
export const CodexChildEvidenceSchema = lazySchema(() => z
  .object({
    nativeThreadId: z.string().trim().min(1).max(512),
    nativeTurnId: z.string().trim().min(1).max(512).optional(),
    parentCollaborationItemId: z.string().trim().min(1).max(512),
    prompt: z.string().max(32_768).optional(),
    nativeEventId: z.string().trim().min(1).max(1_024).optional(),
    nativeItemId: z.string().trim().min(1).max(512).optional(),
    itemEventKey: z.string().trim().min(1).max(512).optional(),
    outcome: TurnOutcomeSchema.optional(),
  })
  .strict());

/** Native Codex evidence that links a receiver turn to its collaboration action. */
export const CodexContinuationEvidenceSchema = lazySchema(() => z
  .object({
    sourceNativeThreadId: z.string().trim().min(1).max(512),
    sourceNativeTurnId: z.string().trim().min(1).max(512),
    sourceNativeItemId: z.string().trim().min(1).max(512),
    targetNativeThreadId: z.string().trim().min(1).max(512),
  })
  .strict());

/** Native Codex collaboration input that has no renderer-facing meaning. */
export const CodexCollaborationEvidenceSchema = lazySchema(() => z
  .object({
    kind: z.string().trim().min(1).max(128),
    senderThreadId: z.string().trim().min(1).max(512).optional(),
    receiverThreadIds: z.array(z.string().trim().min(1).max(512)).max(32).optional(),
    prompt: z.string().max(32_768).optional(),
    agentName: z.string().trim().min(1).max(512).optional(),
    agentPath: z.string().trim().min(1).max(2_048).optional(),
    model: z.string().trim().min(1).max(512).optional(),
    reasoningEffort: z.string().trim().min(1).max(512).optional(),
  })
  .strict());

/** Provider-native evidence attached to a generic event until an adapter interprets it. */
export const ProviderRuntimeExtensionSchema = lazySchema(() => z
  .object({
    providerId: z.literal("codex"),
    kind: z.literal("codex-collaboration"),
    child: CodexChildEvidenceSchema().optional(),
    continuation: CodexContinuationEvidenceSchema().optional(),
    collaboration: CodexCollaborationEvidenceSchema().optional(),
  })
  .strict()
  .refine(
    (extension) => extension.child !== undefined
      || extension.continuation !== undefined
      || extension.collaboration !== undefined,
    "A provider runtime extension must carry native evidence",
  ));

/** Provider-emitted event that keeps native evidence outside the renderer contract. */
export const ProviderRuntimeEventSchema = lazySchema(() =>
  z.object({
    event: AgentEventSchema(),
    extension: ProviderRuntimeExtensionSchema().optional(),
  }).strict(),
);

/** Provider-emitted event that keeps native evidence outside the renderer contract. */
export type ProviderRuntimeEvent = z.infer<ReturnType<typeof ProviderRuntimeEventSchema>>;

/** Native Codex evidence used to route a private child interaction. */
export type CodexChildEvidence = z.infer<ReturnType<typeof CodexChildEvidenceSchema>>;
/** Native Codex evidence that links a receiver turn to its collaboration action. */
export type CodexContinuationEvidence = z.infer<ReturnType<typeof CodexContinuationEvidenceSchema>>;
/** Native Codex collaboration input that has no renderer-facing meaning. */
export type CodexCollaborationEvidence = z.infer<ReturnType<typeof CodexCollaborationEvidenceSchema>>;
/** Provider-native evidence attached to a generic event until an adapter interprets it. */
export type ProviderRuntimeExtension = z.infer<ReturnType<typeof ProviderRuntimeExtensionSchema>>;

/** Wrap a provider-neutral event when it carries no provider-native extension. */
export function providerRuntimeEvent(event: AgentEvent): ProviderRuntimeEvent {
  return { event };
}
