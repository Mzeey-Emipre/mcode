import * as NodeHTTP from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_OPERATION_METADATA,
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_V2_CORE_OPERATIONS,
} from "@mcode/contracts";
import { MCODE_BROWSER_GUIDE } from "@mcode/thread-orchestration";
import { BrowserAutomationBroker } from "../../execution/broker.js";
import { BrowserAutomationCredentialRegistry } from "../../access/credential-registry.js";
import { BrowserAutomationMcpHandler } from "../mcp-handler.js";
import { BrowserAutomationTelemetry, type BrowserAutomationTelemetryEvent } from "../../observability/telemetry.js";

describe("BrowserAutomationMcpHandler", () => {
  let server: NodeHTTP.Server;
  let endpoint: string;
  let token: string;
  let credentialId: string;
  let credentials: BrowserAutomationCredentialRegistry;
  let handler: BrowserAutomationMcpHandler;
  let execute: ReturnType<typeof vi.fn>;
  let cancelFromProvider: ReturnType<typeof vi.fn>;
  let availableOperations: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    credentials = new BrowserAutomationCredentialRegistry();
    const issued = credentials.issue({
      providerId: "cursor",
      providerSessionId: "provider-session",
      mcodeSessionId: "mcode-session",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "privileged",
      allowedOperations: [...BROWSER_AUTOMATION_OPERATIONS],
    });
    token = issued.token;
    credentialId = issued.credentialId;
    execute = vi.fn(async (_claims, request) => ({
      contractVersion: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: true,
      result: {
        operation: "inspect",
        tabs: [],
        viewport: { width: 1280, height: 720 },
        capabilities: [],
      },
    }));
    cancelFromProvider = vi.fn(() => false);
    availableOperations = vi.fn((claims: { allowedOperations: readonly string[] }) => claims.allowedOperations);
    handler = new BrowserAutomationMcpHandler({
      credentials,
      broker: {
        execute,
        cancelFromProvider,
        availableOperations,
      } as unknown as BrowserAutomationBroker,
      now: () => 1_000,
      maxSequenceEntries: 1,
    });
    server = NodeHTTP.createServer((req, res) => {
      void handler.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function post(body: string, authorization = `Bearer ${token}`): Promise<Response> {
    return fetch(endpoint, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
  }

  it("publishes only the Browser v2 tools with MCP safety annotations", async () => {
    const response = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const payload = await response.json() as any;
    expect(response.status).toBe(200);
    expect(payload.result.tools.map((tool: any) => tool.name)).toEqual([
      "browser_open",
      "browser_inspect",
      "browser_act",
      "browser_tabs",
      "browser_evaluate",
    ]);
    expect(payload.result.tools.find((tool: any) => tool.name === "browser_inspect").annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(payload.result.tools.find((tool: any) => tool.name === "browser_evaluate").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(payload.result.tools.find((tool: any) => tool.name === "browser_evaluate").inputSchema.required).toEqual([
      "idempotencyKey",
      "observationRef",
      "deadlineMs",
      "expression",
    ]);
  });

  it("rejects retired top-level Browser tool names", async () => {
    const response = await post(JSON.stringify({
      jsonrpc: "2.0",
      id: "retired-tool",
      method: "tools/call",
      params: { name: "browser_status" },
    }));
    expect((await response.json() as any).error.code).toBe(-32602);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex", "cursor", "copilot"])(
    "publishes the same Browser v2 contract and typed recovery for %s during transient unavailability",
    async (providerId) => {
      const issued = credentials.issue({
        providerId,
        providerSessionId: `${providerId}-provider-session`,
        mcodeSessionId: `${providerId}-mcode-session`,
        threadId: `${providerId}-thread`,
        workspaceId: "workspace-a",
        worktreeIdentity: "worktree-a",
        permissionCapability: "interact",
        allowedOperations: ["open", "inspect", "act", "tabs"],
      });
      handler = new BrowserAutomationMcpHandler({
        credentials,
        broker: new BrowserAutomationBroker({ now: () => 1_000 }),
        now: () => 1_000,
      });
      const authorization = `Bearer ${issued.token}`;

      const initialized = await post(JSON.stringify({
        jsonrpc: "2.0",
        id: `${providerId}-initialize`,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }), authorization);
      const initialization = (await initialized.json() as any).result;
      expect(initialization.serverInfo.version).toBe(String(BROWSER_AUTOMATION_CONTRACT_VERSION));
      expect(initialization.instructions).toBe(MCODE_BROWSER_GUIDE);

      const listed = await post(JSON.stringify({
        jsonrpc: "2.0",
        id: `${providerId}-list`,
        method: "tools/list",
        params: {},
      }), authorization);
      const tools = (await listed.json() as any).result.tools;
      const expectedCoreToolNames = BROWSER_V2_CORE_OPERATIONS.map(
        (operation) => BROWSER_AUTOMATION_OPERATION_METADATA[operation].mcpName,
      );
      expect(tools.map((tool: any) => tool.name)).toEqual(expectedCoreToolNames);
      for (const toolName of expectedCoreToolNames) {
        expect(initialization.instructions).toContain(toolName);
      }
      expect(JSON.stringify(tools)).not.toMatch(/browser_(status|navigate|resize|snapshot|screenshot|click|type|press|scroll|wait_for|console|network|accessibility|performance|recording_start|recording_stop)/);
      expect(tools.find((tool: any) => tool.name === "browser_inspect").description)
        .toContain("canonical session-specific");
      expect(tools.find((tool: any) => tool.name === "browser_act").description)
        .toContain("observationRef");

      const inspected = await post(JSON.stringify({
        jsonrpc: "2.0",
        id: `${providerId}-inspect`,
        method: "tools/call",
        params: { name: "browser_inspect" },
      }), authorization);
      const content = (await inspected.json() as any).result.content[0].text;
      expect(JSON.parse(content)).toMatchObject({
        code: "HOST_UNAVAILABLE",
        stage: "transport",
        effect: "none",
        recovery: "wait",
      });
    },
  );

  it("keeps one correlation identity across MCP routing and receipt delivery", async () => {
    const events: BrowserAutomationTelemetryEvent[] = [];
    const telemetry = new BrowserAutomationTelemetry({ sink: (event) => events.push(event) });
    const issued = credentials.issue({
      providerId: "claude",
      providerSessionId: "correlation-provider-session",
      mcodeSessionId: "correlation-mcode-session",
      threadId: "correlation-thread",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "observe",
      allowedOperations: ["inspect"],
    });
    handler = new BrowserAutomationMcpHandler({
      credentials,
      broker: new BrowserAutomationBroker({ now: () => 1_000, telemetry }),
      now: () => 1_000,
    });

    await post(JSON.stringify({
      jsonrpc: "2.0",
      id: "correlated-inspect",
      method: "tools/call",
      params: { name: "browser_inspect", arguments: {} },
    }), `Bearer ${issued.token}`);

    expect(events.map((event) => event.stage)).toEqual([
      "mcp-routing",
      "configuration",
      "admission",
      "settlement",
      "cleanup",
      "receipt-delivery",
    ]);
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1);
  });

  it("advertises browser_evaluate only when live negotiation permits it", async () => {
    const issued = credentials.issue({
      providerId: "codex",
      providerSessionId: "evaluate-provider-session",
      mcodeSessionId: "evaluate-mcode-session",
      threadId: "evaluate-thread",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "privileged",
      allowedOperations: ["open", "inspect", "act", "tabs", "evaluate"],
    });
    const authorization = `Bearer ${issued.token}`;

    availableOperations.mockReturnValue([]);
    const unavailable = await post(JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/list", params: {} }), authorization);
    expect((await unavailable.json() as any).result.tools.map((tool: any) => tool.name)).not.toContain("browser_evaluate");

    availableOperations.mockReturnValue(["evaluate"]);
    const negotiated = await post(JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/list", params: {} }), authorization);
    expect((await negotiated.json() as any).result.tools.map((tool: any) => tool.name)).toEqual([
      "browser_open",
      "browser_inspect",
      "browser_act",
      "browser_tabs",
      "browser_evaluate",
    ]);
  });

  it("discovers browser_act with bounded required arguments and rejects invalid batches before broker execution", async () => {
    const act = credentials.issue({
      providerId: "cursor",
      providerSessionId: "act-provider",
      mcodeSessionId: "act-mcode",
      threadId: "thread-act",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "interact",
      allowedOperations: ["act"],
    });
    const listed = await post(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }), `Bearer ${act.token}`);
    const tool = (await listed.json() as any).result.tools[0];
    expect(tool.name).toBe("browser_act");
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["idempotencyKey", "observationRef", "deadlineMs", "steps"]));
    expect(tool.inputSchema.properties.deadlineMs).toMatchObject({ type: "integer", maximum: 60_000 });
    expect(tool.inputSchema.properties.steps).toMatchObject({ type: "array", minItems: 1, maxItems: 8 });
    const variants = tool.inputSchema.properties.steps.items.oneOf;
    const click = variants.find((variant: any) => variant.properties.operation.const === "click");
    expect(click).toMatchObject({
      required: ["operation", "target"],
      additionalProperties: false,
      properties: { operation: { const: "click" }, target: { oneOf: expect.any(Array) } },
    });
    expect(click.properties.target.oneOf).toHaveLength(4);
    const wait = variants.find((variant: any) => variant.properties.operation.const === "wait");
    expect(wait).toMatchObject({
      required: ["operation", "durationMs"],
      additionalProperties: false,
      properties: { operation: { const: "wait" }, durationMs: { type: "integer", minimum: 1, maximum: 60_000 } },
    });
    expect(variants).toHaveLength(15);
    const invalid = await post(JSON.stringify({
      jsonrpc: "2.0", id: 11, method: "tools/call", params: {
        name: "browser_act",
        arguments: { idempotencyKey: "key", observationRef: "obs", deadlineMs: 1_000, steps: [] },
      },
    }), `Bearer ${act.token}`);
    expect((await invalid.json() as any).error.code).toBe(-32602);
    expect(execute).not.toHaveBeenCalled();
  });

  it("advertises and routes browser_tabs actions for an interact credential", async () => {
    const tabs = credentials.issue({
      providerId: "cursor",
      providerSessionId: "tabs-provider",
      mcodeSessionId: "tabs-mcode",
      threadId: "thread-tabs",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "interact",
      allowedOperations: ["tabs"],
    });
    const listed = await post(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }), `Bearer ${tabs.token}`);
    const tool = (await listed.json() as any).result.tools[0];
    expect(tool.name).toBe("browser_tabs");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(tool.inputSchema.oneOf).toBeUndefined();
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["action", "idempotencyKey", "observationRef"]));
    expect(tool.inputSchema.properties.action.enum).toEqual(["select", "claim", "release", "close", "finalize"]);
    expect(tool.inputSchema.properties.dispositions.items).toMatchObject({
      required: ["tabId", "disposition"],
      additionalProperties: false,
    });
    const response = await post(JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "browser_tabs",
        arguments: { action: "select", tabId: "tab-2", idempotencyKey: "tabs-key", observationRef: "obs-1" },
      },
    }), `Bearer ${tabs.token}`);
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-tabs" }), expect.objectContaining({
      operation: "tabs",
      args: { action: "select", tabId: "tab-2", idempotencyKey: "tabs-key", observationRef: "obs-1" },
    }));

    execute.mockClear();
    const invalid = await post(JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "browser_tabs",
        arguments: { action: "select", idempotencyKey: "tabs-key-2", observationRef: "obs-1" },
      },
    }), `Bearer ${tabs.token}`);
    expect((await invalid.json() as any).error.code).toBe(-32602);
    expect(execute).not.toHaveBeenCalled();
  });

  it("discovers and routes browser_inspect for an authorized credential", async () => {
    const inspect = credentials.issue({
      providerId: "cursor",
      providerSessionId: "inspect-provider",
      mcodeSessionId: "inspect-mcode",
      threadId: "thread-inspect",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "observe",
      allowedOperations: ["inspect"],
    });
    const listed = await post(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      `Bearer ${inspect.token}`,
    );
    expect((await listed.json() as any).result.tools.map((tool: any) => tool.name)).toEqual(["browser_inspect"]);
    const called = await post(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_inspect" } }),
      `Bearer ${inspect.token}`,
    );
    expect(called.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-inspect" }), expect.objectContaining({ operation: "inspect" }));
  });

  it("projects inspect screenshots as MCP image content without duplicating base64 in text", async () => {
    const inspect = credentials.issue({
      providerId: "cursor",
      providerSessionId: "screenshot-provider",
      mcodeSessionId: "screenshot-mcode",
      threadId: "thread-screenshot",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "observe",
      allowedOperations: ["inspect"],
    });
    const screenshotData = "iVBORw0KGgo=";
    execute.mockImplementationOnce(async (_claims, request) => ({
      contractVersion: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: true,
      result: {
        operation: "inspect",
        tabs: [],
        screenshot: {
          mediaType: "image/png",
          dataBase64: screenshotData,
          width: 320,
          height: 180,
          truncation: { truncated: false },
        },
      },
    }));

    const response = await post(JSON.stringify({
      jsonrpc: "2.0",
      id: "inspect-screenshot",
      method: "tools/call",
      params: { name: "browser_inspect", arguments: { includeScreenshot: true } },
    }), `Bearer ${inspect.token}`);
    const payload = await response.json() as any;
    expect(payload).toHaveProperty("result");
    const content = payload.result.content;

    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[0].text).not.toContain(screenshotData);
    expect(JSON.parse(content[0].text)).toMatchObject({
      operation: "inspect",
      screenshot: { mediaType: "image/png", width: 320, height: 180, truncation: { truncated: false } },
    });
    expect(content[1]).toEqual({ type: "image", data: screenshotData, mimeType: "image/png" });
  });

  it("keeps non-image inspect results and failures as one text content block", async () => {
    const inspect = credentials.issue({
      providerId: "cursor",
      providerSessionId: "plain-inspect-provider",
      mcodeSessionId: "plain-inspect-mcode",
      threadId: "thread-plain-inspect",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "observe",
      allowedOperations: ["inspect"],
    });
    const authorization = `Bearer ${inspect.token}`;
    const inspectResult = { operation: "inspect", tabs: [] };
    execute.mockImplementationOnce(async (_claims, request) => ({
      contractVersion: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: true,
      result: inspectResult,
    }));
    const inspectResponse = await post(JSON.stringify({
      jsonrpc: "2.0",
      id: "inspect-plain",
      method: "tools/call",
      params: { name: "browser_inspect" },
    }), authorization);
    const inspectContent = (await inspectResponse.json() as any).result.content;
    expect(inspectContent).toEqual([{ type: "text", text: JSON.stringify(inspectResult) }]);

    const error = { code: "HOST_UNAVAILABLE", message: "Browser host is unavailable", retryable: true };
    execute.mockImplementationOnce(async (_claims, request) => ({
      contractVersion: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: false,
      error,
    }));
    const failureResponse = await post(JSON.stringify({
      jsonrpc: "2.0",
      id: "inspect-failure",
      method: "tools/call",
      params: { name: "browser_inspect" },
    }), authorization);
    const failurePayload = await failureResponse.json() as any;
    expect(failurePayload.result.content).toEqual([{ type: "text", text: JSON.stringify(error) }]);
    expect(failurePayload.result.isError).toBe(true);
  });

  it("binds tool requests to credential scope instead of accepting caller scope", async () => {
    const response = await post(JSON.stringify({ jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "browser_inspect" } }));
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: "workspace-a",
      threadId: "thread-a",
      providerSessionId: "provider-session",
      providerInstanceId: "mcode-session",
      operation: "inspect",
    });
  });

  it("negotiates both supported MCP protocol versions", async () => {
    for (const protocolVersion of ["2024-11-05", "2025-03-26"]) {
      const response = await post(JSON.stringify({ jsonrpc: "2.0", id: protocolVersion, method: "initialize", params: { protocolVersion } }));
      expect((await response.json() as any).result.protocolVersion).toBe(protocolVersion);
    }
  });

  it("bounds and explicitly releases per-credential sequence state", async () => {
    await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_inspect" } }));
    const second = credentials.issue({
      providerId: "cursor",
      providerSessionId: "provider-session-2",
      mcodeSessionId: "mcode-session-2",
      threadId: "thread-b",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
      permissionCapability: "observe",
      allowedOperations: ["inspect"],
    });
    await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_inspect" } }), `Bearer ${second.token}`);
    expect(handler.releaseCredential(credentialId)).toBe(false);
    expect(handler.releaseCredential(second.credentialId)).toBe(true);
    expect(handler.releaseCredential(second.credentialId)).toBe(false);
  });

  it("returns the same unauthorized response for missing and wrong bearer credentials", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const missing = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
    const wrong = await post(body, "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await missing.text()).toBe(await wrong.text());
  });

  it("rejects malformed, hostile, and oversized requests before broker execution", async () => {
    const malformed = await post("{not-json");
    expect(malformed.status).toBe(400);
    const hostile = await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_inspect", arguments: { threadId: "thread-b" } } }));
    expect((await hostile.json() as any).error.code).toBe(-32602);
    const oversized = await post(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_inspect", arguments: { padding: "x".repeat(256 * 1_024) } } }));
    expect(oversized.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces POST for the MCP route", async () => {
    const response = await fetch(endpoint, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("maps MCP cancellation notifications to the exact active broker request", async () => {
    execute.mockImplementationOnce((_claims, request) => new Promise((resolve) => {
      cancelFromProvider.mockImplementationOnce(() => {
        resolve({
          contractVersion: 1,
          requestId: request.requestId,
          sequence: request.sequence,
          ok: false,
          error: { code: "OPERATION_CANCELLED", message: "cancelled", retryable: false },
        });
        return true;
      });
    }));
    const call = post(JSON.stringify({
      jsonrpc: "2.0",
      id: "provider-call-1",
      method: "tools/call",
      params: { name: "browser_inspect" },
    }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const internalRequest = execute.mock.calls[0]![1];
    const cancelled = await post(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "provider-call-1", reason: "user stopped" },
    }));

    expect(cancelled.status).toBe(202);
    expect(cancelFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId }),
      internalRequest.requestId,
      internalRequest.sequence,
    );
    await expect(call).resolves.toHaveProperty("status", 200);
  });

  it("cancels broker work when the HTTP response disconnects", async () => {
    execute.mockImplementationOnce((_claims, request) => new Promise((resolve) => {
      cancelFromProvider.mockImplementationOnce(() => {
        resolve({
          contractVersion: 1,
          requestId: request.requestId,
          sequence: request.sequence,
          ok: false,
          error: { code: "OPERATION_CANCELLED", message: "disconnected", retryable: false },
        });
        return true;
      });
    }));
    const controller = new AbortController();
    const pendingFetch = fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: { name: "browser_inspect" },
      }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const internalRequest = execute.mock.calls[0]![1];
    controller.abort();
    await expect(pendingFetch).rejects.toThrow();
    await vi.waitFor(() => expect(cancelFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId }),
      internalRequest.requestId,
      internalRequest.sequence,
    ));
  });
});
