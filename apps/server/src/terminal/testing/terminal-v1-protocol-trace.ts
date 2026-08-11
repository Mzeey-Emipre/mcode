import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_MAX_EXECUTABLE_TRACE_STEPS,
  type TerminalBinaryFrame,
} from "@mcode/contracts";
import {
  InMemoryPtyHostProtocol,
  type PtyHostEvent,
  type PtyHostServerMessage,
} from "../host/pty-host-protocol.js";

/** One validated action in a Terminal v1 contract trace. */
export type TerminalV1ProtocolTraceStep =
  | { readonly channel: "server-to-host"; readonly value: unknown }
  | { readonly channel: "host-to-server"; readonly value: unknown }
  | { readonly channel: "attachment"; readonly value: TerminalBinaryFrame };

/** Validated records produced by one Terminal v1 contract trace. */
export interface TerminalV1ProtocolTraceResult {
  readonly hostMessages: readonly PtyHostServerMessage[];
  readonly hostEvents: readonly PtyHostEvent[];
  readonly attachmentFrames: readonly TerminalBinaryFrame[];
}

/** Executes a Terminal v1 trace through the public and private protocol codecs. */
export function executeTerminalV1ProtocolTrace(
  hostGeneration: string,
  steps: ReadonlyArray<TerminalV1ProtocolTraceStep>,
): TerminalV1ProtocolTraceResult {
  if (steps.length > TERMINAL_MAX_EXECUTABLE_TRACE_STEPS) {
    throw new Error("Terminal protocol trace exceeds 256 steps");
  }
  const hostProtocol = new InMemoryPtyHostProtocol(hostGeneration);
  const attachmentFrames: TerminalBinaryFrame[] = [];

  for (const step of steps) {
    switch (step.channel) {
      case "server-to-host":
        hostProtocol.sendToHost(step.value);
        break;
      case "host-to-server":
        hostProtocol.receiveFromHost(step.value);
        break;
      case "attachment":
        attachmentFrames.push(decodeTerminalFrame(encodeTerminalFrame(step.value)));
        break;
    }
  }

  return {
    hostMessages: hostProtocol.messages(),
    hostEvents: hostProtocol.events(),
    attachmentFrames,
  };
}
