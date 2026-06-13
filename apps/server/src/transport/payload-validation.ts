import type { z } from "zod";
import { logger } from "@mcode/shared";

/** Result of validating a server push payload before delivery. */
export type PushValidationResult =
  | { ok: true; data: unknown }
  | { ok: false };

/** Adapter seam for hot-path push and RPC response validation. */
export interface TransportPayloadValidator {
  validatePush(channel: string, data: unknown, schema: z.ZodTypeAny): PushValidationResult;
  validateRpcResult(method: string, result: unknown, schema: z.ZodTypeAny): void;
}

/** Builds the dev adapter that parses payloads and logs schema drift. */
export function createValidatingTransportPayloadValidator(): TransportPayloadValidator {
  return {
    validatePush(channel, data, schema) {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        logger.warn("Push data validation failed", {
          channel,
          error: parsed.error.message,
        });
        return { ok: false };
      }
      return { ok: true, data: parsed.data };
    },
    validateRpcResult(method, result, schema) {
      const parsed = schema.safeParse(result);
      if (!parsed.success) {
        logger.warn("Result validation failed", {
          method,
          error: parsed.error.message,
        });
      }
    },
  };
}

/** Builds the production adapter that leaves payloads untouched. */
export function createPassThroughTransportPayloadValidator(): TransportPayloadValidator {
  return {
    validatePush(_channel, data) {
      return { ok: true, data };
    },
    validateRpcResult() {},
  };
}

let validator: TransportPayloadValidator =
  process.env.NODE_ENV === "production"
    ? createPassThroughTransportPayloadValidator()
    : createValidatingTransportPayloadValidator();

/** Return the process-wide transport payload validator. */
export function getTransportPayloadValidator(): TransportPayloadValidator {
  return validator;
}

/** Replace the process-wide transport payload validator. Intended for tests. */
export function setTransportPayloadValidatorForTest(next: TransportPayloadValidator): void {
  validator = next;
}

/** Restore the default dev/prod validator. Intended for tests. */
export function resetTransportPayloadValidatorForTest(): void {
  validator =
    process.env.NODE_ENV === "production"
      ? createPassThroughTransportPayloadValidator()
      : createValidatingTransportPayloadValidator();
}
