import { afterEach, describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import {
  resetTransportPayloadValidatorForTest,
  setTransportPayloadValidatorForTest,
  type TransportPayloadValidator,
} from "./payload-validation.js";

describe("routeMessage result validation seam", () => {
  afterEach(() => {
    resetTransportPayloadValidatorForTest();
  });

  it("delegates RPC result validation to the configured adapter", async () => {
    const validateRpcResult = vi.fn();
    const validator: TransportPayloadValidator = {
      validatePush: (_channel, data) => ({ ok: true, data }),
      validateRpcResult,
    };
    setTransportPayloadValidatorForTest(validator);

    const response = await routeMessage(
      JSON.stringify({ id: "req-1", method: "app.version", params: {} }),
      {} as RouterDeps,
    );

    expect(response.id).toBe("req-1");
    expect(typeof response.result).toBe("string");
    expect(validateRpcResult).toHaveBeenCalledWith(
      "app.version",
      response.result,
      expect.anything(),
    );
  });
});
