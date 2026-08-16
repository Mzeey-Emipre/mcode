export {
  executeWebInteraction,
  isExecutorGeneratedEvent,
  isTrustedHumanInputEvent,
  observeWebHumanInput,
  redactBrowserLocation,
  redactBrowserText,
  resolveSameOriginFrame,
  resolveWebTarget,
} from "@/features/preview/automation/webBrowserInteractionExecutor";
export type {
  WebInteractionGuard,
  WebInteractionTargetDocument,
  WebTargetResolution,
} from "@/features/preview/automation/webBrowserInteractionExecutor";
