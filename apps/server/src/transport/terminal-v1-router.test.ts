import { describe, expect, it } from "vitest";
import { TerminalRpcResponseSchema } from "@mcode/contracts";
import { TerminalBackendError } from "../terminal/terminal-backend.js";
import { routeMessage, type RouterDeps } from "./ws-router.js";

const sessionId = "00000000-0000-4000-8000-000000000001";

describe("Terminal v1 RPC routing", () => {
  it("serializes typed failures in the frozen top-level error envelope", async () => {
    const deps = {
      terminalService: {
        routeV1: async () => {
          throw new TerminalBackendError("HOST_UNHEALTHY", "SAFE_RETRY", "Host is unhealthy", "corr-1");
        },
      },
    } as unknown as RouterDeps;
    const response = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.session.hasChildren",
      params: { sessionId },
    }), deps, { client: {} as never });

    expect(response).toEqual({
      id: sessionId,
      error: {
        code: "HOST_UNHEALTHY",
        message: "Host is unhealthy",
        retry: "SAFE_RETRY",
        correlationId: "corr-1",
      },
    });
    expect(TerminalRpcResponseSchema("terminal.session.hasChildren").parse(response)).toEqual(response);
  });
});
