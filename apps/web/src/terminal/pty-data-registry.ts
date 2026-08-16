export {
  emitPtyData,
  emitPtyExit,
  emitPtyReconnectGap,
  onPtyData,
  onPtyExit,
  onPtyReconnectGap,
} from "@/features/terminal/adapters/pty-data-registry";
export type {
  PtyDataPayload,
  PtyExitPayload,
  PtyReconnectGapPayload,
} from "@/features/terminal/adapters/pty-data-registry";
