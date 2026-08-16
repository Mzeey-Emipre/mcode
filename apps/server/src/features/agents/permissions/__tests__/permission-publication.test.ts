import { describe, expect, it, vi } from "vitest";
import { publishAgentPermissionEvents } from "../permission-publication.js";

type HandlerMap = {
  permission_request?: (request: unknown) => void;
  permission_resolved?: (payload: unknown) => void;
};

function buildPublication() {
  const handlers: HandlerMap = {};
  const provider = {
    id: "claude",
    on: vi.fn((event: keyof HandlerMap, handler: (payload: never) => void) => {
      handlers[event] = handler as HandlerMap[typeof event];
    }),
  };
  const publishPermissionRequest = vi.fn();
  const publishPermissionResolved = vi.fn();
  publishAgentPermissionEvents({
    providerRegistry: { resolveAll: () => [provider] } as never,
    publishPermissionRequest,
    publishPermissionResolved,
  });
  return { handlers, publishPermissionRequest, publishPermissionResolved };
}

describe("agent permission publication", () => {
  it("publishes validated provider permission lifecycle events", () => {
    const publication = buildPublication();

    publication.handlers.permission_request?.({
      requestId: "request-1",
      threadId: "thread-1",
      toolName: "Bash",
      input: { command: "bun test" },
    });
    publication.handlers.permission_resolved?.({ requestId: "request-1", decision: "allow" });

    expect(publication.publishPermissionRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      threadId: "thread-1",
      toolName: "Bash",
      input: { command: "bun test" },
    });
    expect(publication.publishPermissionResolved).toHaveBeenCalledWith({
      requestId: "request-1",
      decision: "allow",
    });
  });

  it("does not publish malformed provider permission events", () => {
    const publication = buildPublication();

    publication.handlers.permission_request?.({ requestId: "request-1" });
    publication.handlers.permission_resolved?.({ requestId: 42, decision: "allow" });

    expect(publication.publishPermissionRequest).not.toHaveBeenCalled();
    expect(publication.publishPermissionResolved).not.toHaveBeenCalled();
  });
});
