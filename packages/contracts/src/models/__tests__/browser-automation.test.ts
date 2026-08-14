import { describe, expect, it } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
  BROWSER_AUTOMATION_ERROR_CODES,
  BROWSER_AUTOMATION_MAX_AX_NODES,
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BROWSER_AUTOMATION_MAX_ELEMENTS,
  BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES,
  BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
  BROWSER_AUTOMATION_MAX_RECORDING_BYTES,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS,
  BROWSER_AUTOMATION_MAX_URL_CHARS,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS,
  BROWSER_AUTOMATION_OPERATION_METADATA,
  BROWSER_AUTOMATION_OPERATIONS,
  BrowserAutomationCredentialClaimsSchema,
  BrowserAutomationDiagnosticLocationSchema,
  BrowserAutomationHostDispatchTargetSchema,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationHostRegistrationSchema,
  BrowserAutomationRequestSchema,
  BrowserAutomationResultSchema,
  BrowserAutomationResponseSchema,
  BrowserAutomationSnapshotSchema,
  BrowserAutomationTargetIdentitySchema,
  BrowserAutomationTargetSchema,
  BrowserAutomationUrlSchema,
  resolveBrowserAutomationViewportPresentationScale,
} from "../browser-automation.js";

const requestBase = {
  contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
  workspaceId: "workspace-1",
  threadId: "thread-1",
  providerSessionId: "provider-session-1",
  providerInstanceId: "provider-instance-1",
  requestId: "request-1",
  sequence: 0,
  deadline: Date.now() + 60_000,
  expectedControlEpoch: 0,
};

const target = { role: "button", accessibleName: "Submit" };

const argsByOperation = {
  open: { idempotencyKey: "open-key" },
  inspect: {},
  act: {
    idempotencyKey: "act-key",
    observationRef: "observation-1",
    deadlineMs: 10_000,
    steps: [{ operation: "click", target }],
  },
  tabs: {
    action: "select",
    tabId: "tab-1",
    idempotencyKey: "tabs-key",
    observationRef: "observation-1",
  },
  evaluate: {
    expression: "document.title",
    idempotencyKey: "evaluate-key",
    observationRef: "observation-1",
    deadlineMs: 10_000,
  },
} satisfies Record<(typeof BROWSER_AUTOMATION_OPERATIONS)[number], object>;

const noTruncation = { truncated: false };
const snapshot = {
  url: "https://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  visibleTextTruncation: noTruncation,
  elements: [],
  elementsTruncation: noTruncation,
  accessibility: [],
  accessibilityTruncation: noTruncation,
  console: [],
  consoleTruncation: noTruncation,
  network: [],
  networkTruncation: noTruncation,
  actions: [],
  actionsTruncation: noTruncation,
};

const actionResult = (operation: string) => ({
  operation,
  url: "https://example.test/",
  title: "Example",
  controlEpoch: 1,
});

const resultByOperation = {
  open: actionResult("open"),
  inspect: {
    operation: "inspect",
    tabs: [],
    readiness: { ready: true, state: "ready" },
    capabilities: [...BROWSER_AUTOMATION_OPERATIONS],
  },
  act: {
    operation: "act",
    outcome: "completed",
    stoppingPosition: 1,
    effect: "complete",
    recovery: "inspect",
    receipts: [{ index: 0, operation: "click", status: "applied" }],
    finalObservation: {
      observationRef: "observation-2",
      hostRevision: 1,
      documentRevision: 1,
      controlRevision: 0,
      capabilityRevision: 1,
      observationRevision: 1,
    },
  },
  tabs: {
    operation: "tabs",
    action: "select",
    currentTabId: "tab-1",
    observationRef: "observation-1",
    tabs: [],
  },
  evaluate: {
    operation: "evaluate",
    outcome: "completed",
    stoppingPosition: 1,
    effect: "complete",
    recovery: "inspect",
    receipts: [{ index: 0, operation: "evaluate", status: "applied" }],
    finalObservation: {
      observationRef: "observation-2",
      hostRevision: 1,
      documentRevision: 1,
      controlRevision: 0,
      capabilityRevision: 1,
      observationRevision: 1,
    },
    nextObservationRef: "observation-2",
    valueJson: "null",
  },
} satisfies Record<(typeof BROWSER_AUTOMATION_OPERATIONS)[number], object>;

describe("browser automation operation contract", () => {
  it("defines only the Browser v2 operations and MCP names", () => {
    expect(BROWSER_AUTOMATION_OPERATIONS).toEqual(["open", "inspect", "act", "tabs", "evaluate"]);
    expect(Object.keys(BROWSER_AUTOMATION_OPERATION_METADATA)).toEqual([
      ...BROWSER_AUTOMATION_OPERATIONS,
    ]);
    for (const operation of BROWSER_AUTOMATION_OPERATIONS) {
      expect(BROWSER_AUTOMATION_OPERATION_METADATA[operation].mcpName).toMatch(/^browser_/);
      expect(BROWSER_AUTOMATION_OPERATION_METADATA[operation].operation).toBe(operation);
    }
  });

  it("classifies privileged, input, and diagnostic operations", () => {
    expect(BROWSER_AUTOMATION_OPERATION_METADATA.evaluate.annotations).toEqual({
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: true,
      privileged: true,
    });
    expect(BROWSER_AUTOMATION_OPERATION_METADATA.inspect.annotations.readOnly).toBe(true);
    expect(BROWSER_AUTOMATION_OPERATION_METADATA.act.annotations.destructive).toBe(true);
  });

  it("defines browser_tabs as the idempotent Browser v2 lifecycle surface", () => {
    expect(BROWSER_AUTOMATION_OPERATION_METADATA.tabs).toEqual({
      operation: "tabs",
      mcpName: "browser_tabs",
      annotations: {
        readOnly: false,
        destructive: true,
        idempotent: true,
        openWorld: false,
        privileged: false,
      },
    });
    expect(Object.keys(BROWSER_AUTOMATION_OPERATION_METADATA)).toContain("tabs");

    for (const args of [
      { action: "select", tabId: "tab-2" },
      { action: "claim", tabId: "tab-2" },
      { action: "release" },
      { action: "close" },
      {
        action: "finalize",
        dispositions: [
          { tabId: "tab-1", disposition: "deliverable" },
          { tabId: "tab-2", disposition: "handoff" },
        ],
      },
    ]) {
      expect(BrowserAutomationRequestSchema().safeParse({
        ...requestBase,
        operation: "tabs",
        args: {
          ...args,
          idempotencyKey: `tabs-${args.action}`,
          observationRef: "observation-1",
        },
      }).success).toBe(true);
    }

    expect(BrowserAutomationRequestSchema().safeParse({
      ...requestBase,
      operation: "tabs",
      args: { action: "close", idempotencyKey: "tabs-close" },
    }).success).toBe(false);
    expect(BrowserAutomationRequestSchema().safeParse({
      ...requestBase,
      operation: "tabs",
      args: {
        action: "finalize",
        idempotencyKey: "tabs-finalize",
        observationRef: "observation-1",
        dispositions: [
          { tabId: "tab-1", disposition: "close" },
          { tabId: "tab-1", disposition: "deliverable" },
        ],
      },
    }).success).toBe(false);
  });

  it("validates normalized browser_tabs ownership outcomes", () => {
    expect(BrowserAutomationResultSchema().safeParse({
      operation: "tabs",
      action: "finalize",
      currentTabId: "tab-2",
      observationRef: "observation-2",
      tabs: [
        {
          tabId: "tab-1",
          provenance: "agent-created",
          ownership: "released",
          disposition: "deliverable",
        },
        {
          tabId: "tab-2",
          provenance: "claimed-user",
          ownership: "claimed",
          disposition: "handoff",
        },
      ],
    }).success).toBe(true);
  });

  it.each(BROWSER_AUTOMATION_OPERATIONS)("parses a scoped %s request", (operation) => {
    const parsed = BrowserAutomationRequestSchema().parse({
      ...requestBase,
      operation,
      args: argsByOperation[operation],
    });
    expect(parsed.operation).toBe(operation);
  });

  it.each(BROWSER_AUTOMATION_OPERATIONS)("parses an exhaustive %s result", (operation) => {
    const parsed = BrowserAutomationResponseSchema().safeParse({
      contractVersion: 1,
      requestId: "request-1",
      sequence: 0,
      ok: true,
      result: resultByOperation[operation],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects mismatched operation arguments", () => {
    expect(
      BrowserAutomationRequestSchema().safeParse({
        ...requestBase,
        operation: "inspect",
        args: { target },
      }).success,
    ).toBe(false);
  });

  it("keeps diagnostic inspection requests read-only", () => {
    expect(
      BrowserAutomationRequestSchema().safeParse({
        ...requestBase,
        operation: "inspect",
        args: { clear: true },
      }).success,
    ).toBe(false);
  });

  it("accepts bounded browser_open idempotency and opaque observation references", () => {
    const parsed = BrowserAutomationRequestSchema().parse({
      ...requestBase,
      operation: "open",
      args: { idempotencyKey: "open-key" },
    });
    expect(parsed.args).toEqual({ idempotencyKey: "open-key" });
    expect(BrowserAutomationResultSchema().parse({
      operation: "open",
      url: "about:blank",
      title: "",
      controlEpoch: 0,
      observationRef: "observation-1",
    })).toMatchObject({ observationRef: "observation-1" });
  });

  it("accepts bounded browser_inspect readiness, sticky target, revision, and guidance", () => {
    const parsed = BrowserAutomationRequestSchema().parse({
      ...requestBase,
      operation: "inspect",
      args: { includeScreenshot: false, includeDiagnostics: false },
    });
    expect(parsed.operation).toBe("inspect");
    const response = BrowserAutomationResponseSchema().safeParse({
      contractVersion: 1,
      requestId: "inspect-request",
      sequence: 1,
      ok: true,
      result: {
        operation: "inspect",
        readiness: { ready: true, state: "ready" },
        target: { threadId: "thread-1", tabId: "tab-1", targetGeneration: 1, sticky: true },
        tabs: [{ desktopInstanceId: "desktop-1", windowId: 1, connectionGeneration: 1, threadId: "thread-1", tabId: "tab-1", targetGeneration: 1, active: true, focused: true, lastUsedAt: 1 }],
        snapshot,
        observationRef: "observation-inspect",
        capabilityRevision: 1,
        capabilities: ["inspect"],
        guidance: "Use browser_inspect on visible Preview.",
      },
    });
    expect(response.success).toBe(true);
  });
});

describe("browser automation boundaries", () => {
  it("allows only credential-free HTTP(S) URLs within the length limit", () => {
    const urlPrefix = "https://example.test/";
    const maximumUrl = `${urlPrefix}${"a".repeat(BROWSER_AUTOMATION_MAX_URL_CHARS - urlPrefix.length)}`;
    expect(BrowserAutomationUrlSchema().safeParse("https://example.test/").success).toBe(true);
    expect(BrowserAutomationUrlSchema().safeParse("http://localhost:5173/").success).toBe(true);
    expect(BrowserAutomationUrlSchema().safeParse(maximumUrl).success).toBe(true);
    expect(BrowserAutomationUrlSchema().safeParse(`${maximumUrl}a`).success).toBe(false);
    expect(BrowserAutomationUrlSchema().safeParse("file:///etc/passwd").success).toBe(false);
    expect(BrowserAutomationUrlSchema().safeParse("javascript:alert(1)").success).toBe(false);
    expect(BrowserAutomationUrlSchema().safeParse("https://user:pass@example.test/").success).toBe(
      false,
    );
  });

  it("accepts exactly one complete target strategy", () => {
    for (const valid of [
      { semanticId: "element-1" },
      { role: "button", accessibleName: "Save" },
      { cssSelector: "#save" },
      { x: 10, y: 20 },
    ]) {
      expect(BrowserAutomationTargetSchema().safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      {},
      { role: "button" },
      { x: 10 },
      { semanticId: "element-1", cssSelector: "#save" },
      { role: "button", accessibleName: "Save", x: 10, y: 20 },
    ]) {
      expect(BrowserAutomationTargetSchema().safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts sanitized diagnostic locations across browser source schemes", () => {
    for (const location of [
      "https://example.test/app.js",
      "file:///C:/src/app.ts",
      "webpack://app/src/index.ts",
      "node:internal/modules/cjs/loader",
      "devtools://devtools/bundled/inspector.js",
      "chrome-extension://abcdefghijklmnop/script.js",
      "blob:https://example.test/2c0f",
      "about:blank",
      "data:[redacted]",
    ]) {
      expect(BrowserAutomationDiagnosticLocationSchema().safeParse(location).success).toBe(true);
    }
    for (const location of [
      "https://user:pass@example.test/app.js",
      "https://example.test/app.js?token=secret",
      "https://example.test/app.js#secret",
      "blob:https://user:pass@example.test/2c0f",
      "data:text/javascript,secret",
      "custom://example.test/app.js",
    ]) {
      expect(BrowserAutomationDiagnosticLocationSchema().safeParse(location).success).toBe(false);
    }
  });

  it("validates an exact host dispatch target", () => {
    const dispatchTarget = {
      desktopInstanceId: "desktop-1",
      windowId: 1,
      connectionGeneration: 2,
      threadId: "thread-1",
      tabId: "tab-1",
      targetGeneration: 3,
      active: true,
      focused: true,
      lastUsedAt: 10,
    };
    expect(BrowserAutomationHostDispatchTargetSchema().safeParse(dispatchTarget).success).toBe(true);
    for (const invalid of [
      { ...dispatchTarget, desktopInstanceId: "" },
      { ...dispatchTarget, windowId: 0 },
      { ...dispatchTarget, connectionGeneration: 0 },
      { ...dispatchTarget, threadId: "" },
      { ...dispatchTarget, tabId: "" },
      { ...dispatchTarget, targetGeneration: -1 },
      { ...dispatchTarget, unexpected: true },
    ]) {
      expect(BrowserAutomationHostDispatchTargetSchema().safeParse(invalid).success).toBe(false);
    }
  });

  it("binds a host dispatch to one scope, connection, and target generation", () => {
    const dispatch = {
      scope: {
        workspaceId: requestBase.workspaceId,
        threadId: requestBase.threadId,
        providerSessionId: requestBase.providerSessionId,
        providerInstanceId: requestBase.providerInstanceId,
      },
      connection: {
        desktopInstanceId: "desktop-1",
        windowId: 1,
        connectionGeneration: 2,
        targetGeneration: 3,
      },
      request: { ...requestBase, operation: "status", args: {} },
      target: {
        desktopInstanceId: "desktop-1",
        windowId: 1,
        connectionGeneration: 2,
        threadId: requestBase.threadId,
        tabId: "tab-1",
        targetGeneration: 3,
        active: true,
        focused: true,
        lastUsedAt: 10,
      },
    };

    expect(BrowserAutomationHostDispatchSchema().safeParse(dispatch).success).toBe(true);
    expect(
      BrowserAutomationHostDispatchSchema().safeParse({ ...dispatch, target: undefined }).success,
    ).toBe(false);
    expect(
      BrowserAutomationHostDispatchSchema().safeParse({
        ...dispatch,
        target: { ...dispatch.target, threadId: "another-thread" },
      }).success,
    ).toBe(false);
    expect(
      BrowserAutomationHostDispatchSchema().safeParse({
        ...dispatch,
        target: { ...dispatch.target, targetGeneration: 2 },
      }).success,
    ).toBe(false);
    expect(
      BrowserAutomationHostDispatchSchema().safeParse({
        ...dispatch,
        target: { ...dispatch.target, connectionGeneration: 1 },
      }).success,
    ).toBe(false);
    expect(
      BrowserAutomationHostDispatchSchema().safeParse({
        ...dispatch,
        scope: { ...dispatch.scope, providerSessionId: "another-session" },
      }).success,
    ).toBe(false);
  });

  it("enforces timeout, typed-text, expression, and screenshot request limits", () => {
    const parse = (operation: string, args: object) =>
      BrowserAutomationRequestSchema().safeParse({ ...requestBase, operation, args }).success;

    expect(parse("click", { target, timeoutMs: BROWSER_AUTOMATION_MAX_TIMEOUT_MS })).toBe(true);
    expect(parse("click", { target, timeoutMs: BROWSER_AUTOMATION_MAX_TIMEOUT_MS + 1 })).toBe(false);
    expect(parse("type", { text: "a".repeat(BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS) })).toBe(true);
    expect(parse("type", { text: "a".repeat(BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS + 1) })).toBe(
      false,
    );
    const evaluateEnvelope = {
      idempotencyKey: "evaluate-key",
      observationRef: "observation-1",
      deadlineMs: 10_000,
    };
    expect(parse("evaluate", {
      ...evaluateEnvelope,
      expression: "a".repeat(BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES),
    })).toBe(true);
    expect(
      parse("evaluate", {
        ...evaluateEnvelope,
        expression: "a".repeat(BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES + 1),
      }),
    ).toBe(false);
    expect(parse("evaluate", { expression: "document.title" })).toBe(false);
    expect(parse("screenshot", { maxWidth: BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH })).toBe(true);
    expect(parse("screenshot", { maxWidth: BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH + 1 })).toBe(
      false,
    );
  });

  it("applies the 15 second timeout default", () => {
    const parsed = BrowserAutomationRequestSchema().parse({
      ...requestBase,
      operation: "click",
      args: { target },
    });
    expect(parsed.args.timeoutMs).toBe(BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS);
  });

  it("bounds snapshot text, semantic elements, accessibility, and diagnostics", () => {
    const assertBounded = (field: string, allowed: unknown, rejected: unknown) => {
      expect(BrowserAutomationSnapshotSchema().safeParse({ ...snapshot, [field]: allowed }).success).toBe(
        true,
      );
      expect(BrowserAutomationSnapshotSchema().safeParse({ ...snapshot, [field]: rejected }).success).toBe(
        false,
      );
    };
    assertBounded(
      "visibleText",
      "a".repeat(BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS),
      "a".repeat(BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS + 1),
    );

    const elements = Array.from({ length: BROWSER_AUTOMATION_MAX_ELEMENTS + 1 }, (_, index) => ({
          semanticId: `element-${index}`,
          role: "button",
          accessibleName: "Button",
          disabled: false,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
        }));
    assertBounded("elements", elements.slice(0, BROWSER_AUTOMATION_MAX_ELEMENTS), elements);

    const accessibility = Array.from(
      { length: BROWSER_AUTOMATION_MAX_AX_NODES + 1 },
      (_, index) => ({
            nodeId: `node-${index}`,
            role: "text",
            name: "Text",
            depth: 0,
            ignored: false,
          }),
    );
    assertBounded(
      "accessibility",
      accessibility.slice(0, BROWSER_AUTOMATION_MAX_AX_NODES),
      accessibility,
    );

    const actions = Array.from(
      { length: BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES + 1 },
      () => ({ timestamp: 1, operation: "click", outcome: "succeeded" }),
    );
    assertBounded("actions", actions.slice(0, BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES), actions);

    const consoleEntries = Array.from(
      { length: BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES + 1 },
      () => ({ timestamp: 1, level: "info", text: "Loaded" }),
    );
    assertBounded(
      "console",
      consoleEntries.slice(0, BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      consoleEntries,
    );

    const networkEntries = Array.from(
      { length: BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES + 1 },
      () => ({
        timestamp: 1,
        url: "https://example.test/resource.js",
        method: "GET",
        status: 200,
        failed: false,
      }),
    );
    assertBounded(
      "network",
      networkEntries.slice(0, BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      networkEntries,
    );
  });

  it("requires coherent truncation metadata for snapshot collections", () => {
    expect(
      BrowserAutomationSnapshotSchema().safeParse({
        ...snapshot,
        console: [{ timestamp: 1, level: "info", text: "Loaded" }],
        consoleTruncation: { truncated: true, originalCount: 1, reason: "entry-limit" },
      }).success,
    ).toBe(false);
    expect(
      BrowserAutomationSnapshotSchema().safeParse({
        ...snapshot,
        networkTruncation: { truncated: false, originalCount: 0, reason: "entry-limit" },
      }).success,
    ).toBe(false);
    expect(
      BrowserAutomationSnapshotSchema().safeParse({
        ...snapshot,
        actions: [{ timestamp: 1, operation: "click", outcome: "succeeded" }],
        actionsTruncation: { truncated: true, originalCount: 2 },
      }).success,
    ).toBe(true);
  });

  it("bounds host concurrency and rejects duplicate capabilities", () => {
    const registration = {
      contractVersion: 1,
      hostId: "host-1",
      desktopInstanceId: "desktop-1",
      worktreeIdentity: "worktree-1",
      workspaceIds: ["workspace-1"],
      executorDescriptor: {
        runtime: "electron",
        operations: ["inspect", ...BROWSER_AUTOMATION_OPERATIONS],
        constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
        capabilityRevision: 1,
      },
      capabilities: [{ operation: "status", available: true }],
      maxPendingRequests: BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
      connectedAt: 1,
    };
    expect(BrowserAutomationHostRegistrationSchema().safeParse(registration).success).toBe(true);
    expect(
      BrowserAutomationHostRegistrationSchema().safeParse({
        ...registration,
        maxPendingRequests: BROWSER_AUTOMATION_MAX_PENDING_REQUESTS + 1,
      }).success,
    ).toBe(false);
    expect(
      BrowserAutomationHostRegistrationSchema().safeParse({
        ...registration,
        capabilities: [
          { operation: "status", available: true },
          { operation: "status", available: true },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates opt-in web runtime target identity and positive generations", () => {
    const registration = {
      contractVersion: 1,
      hostId: "host-web",
      runtime: "web",
      desktopInstanceId: "connection-web",
      worktreeIdentity: "worktree-a",
      workspaceIds: ["workspace-a"],
      targetIdentity: {
        worktreeIdentity: "worktree-a",
        connectionId: "connection-web",
        workspaceId: "workspace-a",
        threadId: "thread-a",
        tabId: "tab-a",
        generation: 1,
      },
      executorDescriptor: {
        runtime: "web",
        operations: ["inspect", ...BROWSER_AUTOMATION_OPERATIONS],
        constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
        capabilityRevision: 1,
      },
      capabilities: [{ operation: "status", available: false, unavailableReason: "disabled" }],
      maxPendingRequests: 1,
      connectedAt: 1,
    };
    expect(BrowserAutomationHostRegistrationSchema().safeParse(registration).success).toBe(true);
    expect(BrowserAutomationTargetIdentitySchema().safeParse({
      ...registration.targetIdentity,
      generation: 0,
    }).success).toBe(false);
    expect(BrowserAutomationHostRegistrationSchema().safeParse({
      ...registration,
      targetIdentity: { ...registration.targetIdentity, worktreeIdentity: "other-worktree" },
    }).success).toBe(true);
  });

  it("requires expiring credential claims with unique operations", () => {
    const claims = {
      contractVersion: 1,
      credentialId: "credential-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      providerSessionId: "session-1",
      providerInstanceId: "instance-1",
      operations: ["inspect", "act"],
      issuedAt: 10,
      expiresAt: 20,
    };
    expect(BrowserAutomationCredentialClaimsSchema().safeParse(claims).success).toBe(true);
    expect(
      BrowserAutomationCredentialClaimsSchema().safeParse({ ...claims, expiresAt: 10 }).success,
    ).toBe(false);
    expect(
      BrowserAutomationCredentialClaimsSchema().safeParse({
        ...claims,
        operations: ["inspect", "inspect"],
      }).success,
    ).toBe(false);
  });

  it("rejects success responses over 512 KiB", () => {
    const response = {
      contractVersion: 1,
      requestId: "request-1",
      sequence: 0,
      ok: true,
      result: {
        operation: "recordingStop",
        recordingId: "recording-1",
        mediaType: "video/webm",
        dataBase64: "a".repeat(BROWSER_AUTOMATION_MAX_RESULT_BYTES),
        durationMs: 1,
        truncation: noTruncation,
        controlEpoch: 1,
      },
    };
    expect(BrowserAutomationResponseSchema().safeParse(response).success).toBe(false);
  });

  it("bounds valid recording base64 by decoded size in the result schema", () => {
    const encodeZeroBytes = (byteCount: number): string => {
      const completeGroups = Math.floor(byteCount / 3);
      const remainder = byteCount % 3;
      return `${"AAAA".repeat(completeGroups)}${remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : ""}`;
    };
    const result = (dataBase64: string) => ({
      operation: "recordingStop",
      recordingId: "recording-1",
      mediaType: "video/webm",
      dataBase64,
      durationMs: 1,
      truncation: noTruncation,
      controlEpoch: 1,
    });

    expect(
      BrowserAutomationResultSchema().safeParse(
        result(encodeZeroBytes(BROWSER_AUTOMATION_MAX_RECORDING_BYTES)),
      ).success,
    ).toBe(true);
    expect(
      BrowserAutomationResultSchema().safeParse(
        result(encodeZeroBytes(BROWSER_AUTOMATION_MAX_RECORDING_BYTES + 1)),
      ).success,
    ).toBe(false);
    expect(BrowserAutomationResultSchema().safeParse(result("not-base64")).success).toBe(false);
  });

  it.each(BROWSER_AUTOMATION_ERROR_CODES)("accepts the stable %s error code", (code) => {
    expect(
      BrowserAutomationResponseSchema().safeParse({
        contractVersion: 1,
        requestId: "request-1",
        sequence: 0,
        ok: false,
        error: { code, message: "Safe failure detail", retryable: false },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown error codes", () => {
    expect(
      BrowserAutomationResponseSchema().safeParse({
        contractVersion: 1,
        requestId: "request-1",
        sequence: 0,
        ok: false,
        error: { code: "UNKNOWN", message: "Safe failure detail", retryable: false },
      }).success,
    ).toBe(false);
  });

  it("accepts the typed cross-origin failure used by web Preview", () => {
    expect(
      BrowserAutomationResponseSchema().safeParse({
        contractVersion: 1,
        requestId: "request-1",
        sequence: 0,
        ok: false,
        error: { code: "CROSS_ORIGIN", message: "Visible preview is cross-origin", retryable: false },
      }).success,
    ).toBe(true);
  });

  it("bounds browser_act batches and rejects malformed later steps before effects", () => {
    const valid = {
      ...requestBase,
      operation: "act",
      args: {
        idempotencyKey: "act-key",
        observationRef: "observation-1",
        deadlineMs: 1_000,
        steps: [{ operation: "click", target }],
      },
    };
    expect(BrowserAutomationRequestSchema().safeParse(valid).success).toBe(true);
    expect(BrowserAutomationRequestSchema().safeParse({ ...valid, args: { ...valid.args, steps: [] } }).success).toBe(false);
    expect(BrowserAutomationRequestSchema().safeParse({ ...valid, args: { ...valid.args, steps: Array.from({ length: 9 }, () => valid.args.steps[0]) } }).success).toBe(false);
    expect(BrowserAutomationRequestSchema().safeParse({ ...valid, args: { ...valid.args, deadlineMs: 0 } }).success).toBe(false);
    expect(BrowserAutomationRequestSchema().safeParse({ ...valid, args: { ...valid.args, deadlineMs: 60_001 } }).success).toBe(false);
    expect(BrowserAutomationRequestSchema().safeParse({ ...valid, args: { ...valid.args, steps: [valid.args.steps[0], { operation: "click", target, clickCount: 4 }] } }).success).toBe(false);
  });

  it("allows only supported viewport zoom presentations", () => {
    expect(resolveBrowserAutomationViewportPresentationScale("fit")).toBeNull();
    expect(resolveBrowserAutomationViewportPresentationScale("actual")).toBe(1);
    expect(resolveBrowserAutomationViewportPresentationScale("200%")).toBe(2);
  });
});
