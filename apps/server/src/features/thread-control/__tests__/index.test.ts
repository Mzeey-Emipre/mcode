import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as threadControl from "../index.js";

describe("thread control feature boundary", () => {
  it("exposes only the composition-root thread-control symbols", () => {
    expect(Object.keys(threadControl).sort()).toStrictEqual([
      "EXTERNAL_THREAD_CONTROL_MCP_PATH",
      "ExternalThreadControlMcpRuntime",
      "ExternalThreadControlPairingService",
      "InternalThreadControlMcpAuthority",
      "InternalThreadControlMcpRuntime",
      "ThreadCompletionService",
      "ThreadControlMutationReservationService",
      "ThreadControlService",
      "ThreadService",
      "ThreadTeardownService",
    ]);
  });
});
