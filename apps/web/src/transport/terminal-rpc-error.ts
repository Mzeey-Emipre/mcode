import {
  TerminalErrorCodeSchema,
  TerminalRetryClassSchema,
  type TerminalErrorCode,
  type TerminalRetryClass,
} from "@mcode/contracts";

/** Stable, bounded fields carried by a typed Terminal RPC failure. */
export interface TerminalRpcErrorFields {
  readonly code?: TerminalErrorCode;
  readonly retry?: TerminalRetryClass;
  readonly correlationId?: string;
}

/** Error raised for a Terminal RPC failure without exposing backend detail. */
export class TerminalRpcError extends Error implements TerminalRpcErrorFields {
  readonly code?: TerminalErrorCode;
  readonly retry?: TerminalRetryClass;
  readonly correlationId?: string;

  constructor(error: unknown) {
    super("Terminal request failed");
    this.name = "TerminalRpcError";
    const value = typeof error === "object" && error !== null
      ? error as Record<string, unknown>
      : {};
    const code = TerminalErrorCodeSchema().safeParse(value.code);
    const retry = TerminalRetryClassSchema().safeParse(value.retry);
    const correlationId = typeof value.correlationId === "string" &&
      value.correlationId.length > 0 && value.correlationId.length <= 64
      ? value.correlationId
      : undefined;
    if (code.success) this.code = code.data;
    if (retry.success) this.retry = retry.data;
    if (correlationId) this.correlationId = correlationId;
  }
}

/** Converts a typed Terminal response error while retaining legacy errors unchanged. */
export function toRpcError(error: unknown): Error {
  const value = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  if (TerminalErrorCodeSchema().safeParse(value.code).success) {
    return new TerminalRpcError(value);
  }
  return new Error(typeof value.message === "string" ? value.message : "RPC error");
}
