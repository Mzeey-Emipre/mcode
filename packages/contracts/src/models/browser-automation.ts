import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Current browser automation wire-contract version. */
export const BROWSER_AUTOMATION_CONTRACT_VERSION = 1 as const;
/** Maximum accepted browser URL length. */
export const BROWSER_AUTOMATION_MAX_URL_CHARS = 2_048;
/** Default operation timeout in milliseconds. */
export const BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS = 15_000;
/** Maximum operation timeout in milliseconds. */
export const BROWSER_AUTOMATION_MAX_TIMEOUT_MS = 60_000;
/** Maximum JavaScript expression and evaluation-result size in bytes. */
export const BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES = 64 * 1_024;
/** Maximum visible-text characters returned by a snapshot. */
export const BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS = 20_000;
/** Maximum interactive elements returned by a snapshot. */
export const BROWSER_AUTOMATION_MAX_ELEMENTS = 200;
/** Maximum accessibility nodes returned by one request. */
export const BROWSER_AUTOMATION_MAX_AX_NODES = 1_000;
/** Maximum entries returned by each diagnostic or action-history collection. */
export const BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES = 200;
/** Maximum screenshot width in CSS pixels. */
export const BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH = 1_280;
/** Maximum encoded success result size in bytes. */
export const BROWSER_AUTOMATION_MAX_RESULT_BYTES = 512 * 1_024;
/** Maximum decoded browser recording size in bytes. */
export const BROWSER_AUTOMATION_MAX_RECORDING_BYTES = 512 * 1_024;
/** Maximum requests a browser host may process or queue concurrently. */
export const BROWSER_AUTOMATION_MAX_PENDING_REQUESTS = 32;
/** Maximum text characters accepted by a type operation. */
export const BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS = 16_384;

/** Explicit opt-in environment flag for registration by the pure web runtime. */
export const BROWSER_AUTOMATION_WEB_DEV_FLAG = "MCODE_WEB_AUTOMATION" as const;

const ID_MAX = 256;
const SHORT_TEXT_MAX = 1_024;
const SELECTOR_MAX = 4_096;
const RECORDING_MAX_DURATION_MS = 10 * 60_000;
const RECORDING_MAX_BASE64_CHARS =
  Math.ceil(BROWSER_AUTOMATION_MAX_RECORDING_BYTES / 3) * 4;

const idSchema = z.string().trim().min(1).max(ID_MAX);
const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(BROWSER_AUTOMATION_MAX_TIMEOUT_MS)
  .default(BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS);

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasBoundedJsonSize(value: unknown, limit: number): boolean {
  try {
    return utf8Length(JSON.stringify(value)) <= limit;
  } catch {
    return false;
  }
}

function decodedBase64Size(value: string): number | null {
  if (
    value.length === 0 ||
    value.length > RECORDING_MAX_BASE64_CHARS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Browser operations exposed to provider-neutral automation clients. */
export const BROWSER_AUTOMATION_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "resize",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "press",
  "scroll",
  "waitFor",
  "console",
  "network",
  "accessibility",
  "performance",
  "evaluate",
  "recordingStart",
  "recordingStop",
] as const;

/** One browser automation operation identifier. */
export type BrowserAutomationOperation = (typeof BROWSER_AUTOMATION_OPERATIONS)[number];

/** Provider-facing MCP tool annotations for one operation. */
export interface BrowserAutomationOperationAnnotations {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly privileged: boolean;
}

/** Provider-facing metadata for one browser automation operation. */
export interface BrowserAutomationOperationMetadata {
  readonly operation: BrowserAutomationOperation;
  readonly mcpName: `browser_${string}`;
  readonly annotations: BrowserAutomationOperationAnnotations;
}

const readOnly = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
  privileged: false,
} satisfies BrowserAutomationOperationAnnotations;
const input = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: false,
  privileged: false,
} satisfies BrowserAutomationOperationAnnotations;
const externalInput = {
  ...input,
  openWorld: true,
} satisfies BrowserAutomationOperationAnnotations;

/** Exhaustive MCP names and safety annotations for browser operations. */
export const BROWSER_AUTOMATION_OPERATION_METADATA = {
  status: { operation: "status", mcpName: "browser_status", annotations: readOnly },
  open: {
    operation: "open",
    mcpName: "browser_open",
    annotations: { ...input, openWorld: true },
  },
  navigate: {
    operation: "navigate",
    mcpName: "browser_navigate",
    annotations: { ...input, openWorld: true },
  },
  resize: { operation: "resize", mcpName: "browser_resize", annotations: externalInput },
  snapshot: { operation: "snapshot", mcpName: "browser_snapshot", annotations: readOnly },
  screenshot: {
    operation: "screenshot",
    mcpName: "browser_screenshot",
    annotations: readOnly,
  },
  click: { operation: "click", mcpName: "browser_click", annotations: externalInput },
  type: { operation: "type", mcpName: "browser_type", annotations: externalInput },
  press: { operation: "press", mcpName: "browser_press", annotations: externalInput },
  scroll: { operation: "scroll", mcpName: "browser_scroll", annotations: externalInput },
  waitFor: { operation: "waitFor", mcpName: "browser_wait_for", annotations: readOnly },
  console: { operation: "console", mcpName: "browser_console", annotations: readOnly },
  network: { operation: "network", mcpName: "browser_network", annotations: readOnly },
  accessibility: {
    operation: "accessibility",
    mcpName: "browser_accessibility",
    annotations: readOnly,
  },
  performance: {
    operation: "performance",
    mcpName: "browser_performance",
    annotations: readOnly,
  },
  evaluate: {
    operation: "evaluate",
    mcpName: "browser_evaluate",
    annotations: {
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: true,
      privileged: true,
    },
  },
  recordingStart: {
    operation: "recordingStart",
    mcpName: "browser_recording_start",
    annotations: input,
  },
  recordingStop: {
    operation: "recordingStop",
    mcpName: "browser_recording_stop",
    annotations: input,
  },
} as const satisfies Record<BrowserAutomationOperation, BrowserAutomationOperationMetadata>;

/** Validates a browser URL that cannot carry credentials or leave HTTP(S). */
export const BrowserAutomationUrlSchema = lazySchema(() =>
  z
    .string()
    .min(1)
    .max(BROWSER_AUTOMATION_MAX_URL_CHARS)
    .url()
    .superRefine((value, context) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid browser URL" });
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Only HTTP(S) URLs are allowed" });
      }
      if (parsed.username || parsed.password) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Browser URLs cannot contain credentials" });
      }
    }),
);

/** Bounded sanitized location reported by a browser, including opaque schemes. */
export const BrowserAutomationOutputLocationSchema = lazySchema(() =>
  z.string().min(1).max(BROWSER_AUTOMATION_MAX_URL_CHARS),
);

const diagnosticSchemes = new Set([
  "http:",
  "https:",
  "file:",
  "blob:",
  "data:",
  "about:",
  "chrome-extension:",
  "devtools:",
  "webpack:",
  "node:",
]);

/** Validates a sanitized diagnostic location without URL credentials, queries, or fragments. */
export const BrowserAutomationDiagnosticLocationSchema = lazySchema(() =>
  z
    .string()
    .trim()
    .min(1)
    .max(BROWSER_AUTOMATION_MAX_URL_CHARS)
    .superRefine((value, context) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid diagnostic location" });
        return;
      }
      if (!diagnosticSchemes.has(parsed.protocol)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Diagnostic location scheme is not allowed",
        });
      }
      if (parsed.username || parsed.password) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Diagnostic locations cannot contain credentials",
        });
      }
      if (parsed.search || parsed.hash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Diagnostic locations cannot contain query or fragment data",
        });
      }
      if (parsed.protocol === "data:" && value !== "data:[redacted]") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data diagnostic locations must be redacted",
        });
      }
      if (parsed.protocol === "blob:") {
        try {
          const inner = new URL(value.slice("blob:".length));
          if (inner.username || inner.password || inner.search || inner.hash) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Blob diagnostic locations must contain a sanitized origin",
            });
          }
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Blob diagnostic location is invalid",
          });
        }
      }
    }),
);

/** One sanitized source or request location in browser diagnostics. */
export type BrowserAutomationDiagnosticLocation = z.infer<
  ReturnType<typeof BrowserAutomationDiagnosticLocationSchema>
>;

/** Identifies an element through exactly one supported targeting strategy. */
export const BrowserAutomationTargetSchema = lazySchema(() =>
  z.union([
    z.object({ semanticId: z.string().min(1).max(SHORT_TEXT_MAX) }).strict(),
    z
      .object({
        role: z.string().min(1).max(128),
        accessibleName: z.string().min(1).max(SHORT_TEXT_MAX),
      })
      .strict(),
    z.object({ cssSelector: z.string().min(1).max(SELECTOR_MAX) }).strict(),
    z
      .object({
        x: z.number().finite().min(0).max(100_000),
        y: z.number().finite().min(0).max(100_000),
      })
      .strict(),
  ]),
);

/** One browser element target. */
export type BrowserAutomationTarget = z.infer<ReturnType<typeof BrowserAutomationTargetSchema>>;

/** Marks whether a bounded collection or string was truncated. */
export const BrowserAutomationTruncationSchema = lazySchema(() =>
  z.discriminatedUnion("truncated", [
    z
      .object({
        truncated: z.literal(false),
        originalCount: z.number().int().nonnegative().optional(),
        reason: z.never().optional(),
      })
      .strict(),
    z
      .object({
        truncated: z.literal(true),
        originalCount: z.number().int().positive(),
        reason: z
          .enum(["entry-limit", "byte-limit", "character-limit"])
          .default("entry-limit"),
      })
      .strict(),
  ]),
);

/** Truncation metadata attached to bounded browser data. */
export type BrowserAutomationTruncation = z.infer<
  ReturnType<typeof BrowserAutomationTruncationSchema>
>;

function validateTruncation(
  truncation: BrowserAutomationTruncation,
  retainedCount: number,
  context: z.RefinementCtx,
  path: Array<string | number>,
  allowRetainedShrink = false,
): void {
  const coherent = truncation.truncated
    ? truncation.originalCount > retainedCount
    : truncation.originalCount === undefined ||
      truncation.originalCount === retainedCount ||
      (allowRetainedShrink && truncation.originalCount > retainedCount);
  if (!coherent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Truncation metadata does not match retained data",
      path,
    });
  }
}

/** One semantic interactive element in a browser snapshot. */
export const BrowserAutomationElementSchema = lazySchema(() =>
  z
    .object({
      semanticId: z.string().min(1).max(SHORT_TEXT_MAX),
      role: z.string().max(128),
      accessibleName: z.string().max(SHORT_TEXT_MAX),
      value: z.string().max(SHORT_TEXT_MAX).optional(),
      disabled: z.boolean(),
      bounds: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().finite().nonnegative(),
          height: z.number().finite().nonnegative(),
        })
        .strict(),
    })
    .strict(),
);

/** One bounded accessibility-tree node. */
export const BrowserAutomationAccessibilityNodeSchema = lazySchema(() =>
  z
    .object({
      nodeId: z.string().min(1).max(SHORT_TEXT_MAX),
      parentId: z.string().max(SHORT_TEXT_MAX).optional(),
      role: z.string().max(128),
      name: z.string().max(SHORT_TEXT_MAX),
      value: z.string().max(SHORT_TEXT_MAX).optional(),
      depth: z.number().int().nonnegative().max(1_000),
      ignored: z.boolean(),
    })
    .strict(),
);

/** One bounded browser-console entry. */
export const BrowserAutomationConsoleEntrySchema = lazySchema(() =>
  z
    .object({
      timestamp: z.number().int().nonnegative(),
      level: z.enum(["debug", "info", "warning", "error"]),
      text: z.string().max(4_096),
      sourceUrl: BrowserAutomationDiagnosticLocationSchema().optional(),
      line: z.number().int().nonnegative().optional(),
    })
    .strict(),
);

/** One bounded browser-network diagnostic entry. */
export const BrowserAutomationNetworkEntrySchema = lazySchema(() =>
  z
    .object({
      timestamp: z.number().int().nonnegative(),
      url: BrowserAutomationDiagnosticLocationSchema(),
      method: z.string().min(1).max(32),
      status: z.number().int().min(0).max(999).optional(),
      failed: z.boolean(),
      errorText: z.string().max(4_096).optional(),
    })
    .strict(),
);

/** One bounded action-history entry. */
export const BrowserAutomationActionEntrySchema = lazySchema(() =>
  z
    .object({
      timestamp: z.number().int().nonnegative(),
      operation: z.enum(BROWSER_AUTOMATION_OPERATIONS),
      outcome: z.enum(["started", "succeeded", "failed", "interrupted"]),
      detail: z.string().max(SHORT_TEXT_MAX).optional(),
    })
    .strict(),
);

/** A PNG screenshot returned by the visible browser. */
export const BrowserAutomationScreenshotSchema = lazySchema(() =>
  z
    .object({
      mediaType: z.literal("image/png"),
      dataBase64: z.string().max(Math.ceil((BROWSER_AUTOMATION_MAX_RESULT_BYTES * 4) / 3)),
      width: z.number().int().positive().max(BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH),
      height: z.number().int().positive().max(100_000),
      truncation: BrowserAutomationTruncationSchema(),
    })
    .strict()
    .superRefine((value, context) => {
      validateTruncation(value.truncation, value.width, context, ["truncation"]);
    }),
);

/** Bounded semantic and debugging data captured from the visible browser. */
export const BrowserAutomationSnapshotSchema = lazySchema(() =>
  z
    .object({
      url: BrowserAutomationOutputLocationSchema(),
      title: z.string().max(4_096),
      loading: z.boolean(),
      visibleText: z.string().max(BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS),
      visibleTextTruncation: BrowserAutomationTruncationSchema(),
      elements: z.array(BrowserAutomationElementSchema()).max(BROWSER_AUTOMATION_MAX_ELEMENTS),
      elementsTruncation: BrowserAutomationTruncationSchema(),
      accessibility: z
        .array(BrowserAutomationAccessibilityNodeSchema())
        .max(BROWSER_AUTOMATION_MAX_AX_NODES),
      accessibilityTruncation: BrowserAutomationTruncationSchema(),
      console: z
        .array(BrowserAutomationConsoleEntrySchema())
        .max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      consoleTruncation: BrowserAutomationTruncationSchema(),
      network: z
        .array(BrowserAutomationNetworkEntrySchema())
        .max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      networkTruncation: BrowserAutomationTruncationSchema(),
      actions: z
        .array(BrowserAutomationActionEntrySchema())
        .max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      actionsTruncation: BrowserAutomationTruncationSchema(),
      screenshot: BrowserAutomationScreenshotSchema().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      validateTruncation(
        value.visibleTextTruncation,
        value.visibleText.length,
        context,
        ["visibleTextTruncation"],
        true,
      );
      validateTruncation(value.elementsTruncation, value.elements.length, context, ["elementsTruncation"]);
      validateTruncation(
        value.accessibilityTruncation,
        value.accessibility.length,
        context,
        ["accessibilityTruncation"],
      );
      validateTruncation(value.consoleTruncation, value.console.length, context, ["consoleTruncation"]);
      validateTruncation(value.networkTruncation, value.network.length, context, ["networkTruncation"]);
      validateTruncation(value.actionsTruncation, value.actions.length, context, ["actionsTruncation"]);
    }),
);

/** Structured performance metrics captured from the visible browser tab. */
export const BrowserAutomationPerformanceMetricsSchema = lazySchema(() =>
  z
    .object({
      capturedAt: z.number().int().nonnegative(),
      navigation: z
        .object({
          timeToFirstByteMs: z.number().finite().nonnegative().optional(),
          domContentLoadedMs: z.number().finite().nonnegative().optional(),
          loadMs: z.number().finite().nonnegative().optional(),
        })
        .strict(),
      resources: z
        .object({
          count: z.number().int().nonnegative().max(100_000),
          transferBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          decodedBodyBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      responsiveness: z
        .object({
          longTaskCount: z.number().int().nonnegative().max(100_000),
          totalBlockingTimeMs: z.number().finite().nonnegative(),
        })
        .strict(),
      memory: z
        .object({
          usedJsHeapBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          totalJsHeapBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          jsHeapLimitBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict()
        .optional(),
    })
    .strict(),
);

/** Structured performance metrics for an agent audit. */
export type BrowserAutomationPerformanceMetrics = z.infer<
  ReturnType<typeof BrowserAutomationPerformanceMetricsSchema>
>;

/** Browser controller identity and interruption epoch for one tab. */
export const BrowserAutomationControllerStateSchema = lazySchema(() =>
  z
    .object({
      tabId: idSchema,
      controller: z.enum(["none", "human", "agent"]),
      controlEpoch: z.number().int().nonnegative(),
      providerSessionId: idSchema.optional(),
      operation: z.enum(BROWSER_AUTOMATION_OPERATIONS).optional(),
      pointer: z.object({
        x: z.number().finite().min(0).max(100_000),
        y: z.number().finite().min(0).max(100_000),
      }).strict().optional(),
    })
    .strict(),
);

/** Browser controller state for one tab. */
export type BrowserAutomationControllerState = z.infer<
  ReturnType<typeof BrowserAutomationControllerStateSchema>
>;

/** Runtime that owns one browser automation host connection. */
export const BrowserAutomationHostRuntimeSchema = z.enum(["electron", "web"]);
/** Browser automation host runtime discriminator. */
export type BrowserAutomationHostRuntime = z.infer<typeof BrowserAutomationHostRuntimeSchema>;

/** Provider-neutral identity for one bounded web target registration. */
export const BrowserAutomationTargetIdentitySchema = lazySchema(() =>
  z.object({
    worktreeIdentity: idSchema,
    connectionId: idSchema,
    workspaceId: idSchema,
    threadId: idSchema,
    tabId: idSchema,
    generation: z.number().int().positive(),
  }).strict(),
);
/** Provider-neutral identity for one bounded web target registration. */
export type BrowserAutomationTargetIdentity = z.infer<
  ReturnType<typeof BrowserAutomationTargetIdentitySchema>
>;

/** One operation capability advertised by a connected browser host. */
export const BrowserAutomationHostCapabilitySchema = lazySchema(() =>
  z
    .object({
      operation: z.enum(BROWSER_AUTOMATION_OPERATIONS),
      available: z.boolean(),
      unavailableReason: z.string().max(SHORT_TEXT_MAX).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.available && value.unavailableReason !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Available capabilities cannot include an unavailable reason",
        });
      }
      if (!value.available && !value.unavailableReason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Unavailable capabilities require a reason",
        });
      }
    }),
);

/** Registration sent by a browser host when it connects to the broker. */
export const BrowserAutomationHostRegistrationSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(BROWSER_AUTOMATION_CONTRACT_VERSION),
      hostId: idSchema,
      runtime: BrowserAutomationHostRuntimeSchema.default("electron"),
      desktopInstanceId: idSchema,
      worktreeIdentity: idSchema,
      workspaceIds: z.array(idSchema).min(1).max(32),
      targetIdentity: BrowserAutomationTargetIdentitySchema().optional(),
      capabilities: z
        .array(BrowserAutomationHostCapabilitySchema())
        .min(1)
        .max(BROWSER_AUTOMATION_OPERATIONS.length),
      maxPendingRequests: z
        .number()
        .int()
        .min(1)
        .max(BROWSER_AUTOMATION_MAX_PENDING_REQUESTS),
      connectedAt: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((value, context) => {
      const operations = value.capabilities.map((capability) => capability.operation);
      if (new Set(operations).size !== operations.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Host capabilities must be unique by operation",
          path: ["capabilities"],
        });
      }
    }),
);

/** Browser-host registration payload. */
export type BrowserAutomationHostRegistration = z.infer<
  ReturnType<typeof BrowserAutomationHostRegistrationSchema>
>;

/** Exact visible-browser target selected for one host dispatch. */
export const BrowserAutomationHostDispatchTargetSchema = lazySchema(() =>
  z
    .object({
      desktopInstanceId: idSchema,
      windowId: z.number().int().positive(),
      connectionGeneration: z.number().int().positive(),
      threadId: idSchema,
      tabId: idSchema,
      targetGeneration: z.number().int().nonnegative(),
      active: z.boolean(),
      focused: z.boolean(),
      lastUsedAt: z.number().int().nonnegative(),
    })
    .strict(),
);

/** Exact visible-browser target selected for one host dispatch. */
export type BrowserAutomationHostDispatchTarget = z.infer<
  ReturnType<typeof BrowserAutomationHostDispatchTargetSchema>
>;

/** Validated broker-to-host envelope binding scope, connection, request, and visible target. */
export const BrowserAutomationHostDispatchSchema = lazySchema(() =>
  z
    .object({
      scope: z
        .object({
          workspaceId: idSchema,
          threadId: idSchema,
          providerSessionId: idSchema,
          providerInstanceId: idSchema,
        })
        .strict(),
      connection: z
        .object({
          desktopInstanceId: idSchema,
          windowId: z.number().int().positive(),
          connectionGeneration: z.number().int().positive(),
          targetGeneration: z.number().int().nonnegative(),
        })
        .strict(),
      request: BrowserAutomationRequestSchema(),
      target: BrowserAutomationHostDispatchTargetSchema(),
    })
    .strict()
    .superRefine((value, context) => {
      const mismatches: Array<[boolean, Array<string | number>, string]> = [
        [value.request.workspaceId !== value.scope.workspaceId, ["request", "workspaceId"], "workspace scope"],
        [value.request.threadId !== value.scope.threadId, ["request", "threadId"], "thread scope"],
        [value.target.threadId !== value.scope.threadId, ["target", "threadId"], "target thread"],
        [
          value.request.providerSessionId !== value.scope.providerSessionId,
          ["request", "providerSessionId"],
          "provider session scope",
        ],
        [
          value.request.providerInstanceId !== value.scope.providerInstanceId,
          ["request", "providerInstanceId"],
          "provider instance scope",
        ],
        [
          value.target.desktopInstanceId !== value.connection.desktopInstanceId,
          ["target", "desktopInstanceId"],
          "desktop connection",
        ],
        [value.target.windowId !== value.connection.windowId, ["target", "windowId"], "window connection"],
        [
          value.target.connectionGeneration !== value.connection.connectionGeneration,
          ["target", "connectionGeneration"],
          "connection generation",
        ],
        [
          value.target.targetGeneration !== value.connection.targetGeneration,
          ["target", "targetGeneration"],
          "target generation",
        ],
      ];
      for (const [mismatched, path, field] of mismatches) {
        if (!mismatched) continue;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Browser host dispatch ${field} does not match its assignment`,
          path,
        });
      }
    }),
);

/** Validated broker-to-host browser dispatch envelope. */
export type BrowserAutomationHostDispatch = z.infer<
  ReturnType<typeof BrowserAutomationHostDispatchSchema>
>;

/** Claims bound to a short-lived browser automation credential. */
export const BrowserAutomationCredentialClaimsSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(BROWSER_AUTOMATION_CONTRACT_VERSION),
      credentialId: idSchema,
      workspaceId: idSchema,
      threadId: idSchema,
      providerSessionId: idSchema,
      providerInstanceId: idSchema,
      operations: z
        .array(z.enum(BROWSER_AUTOMATION_OPERATIONS))
        .min(1)
        .max(BROWSER_AUTOMATION_OPERATIONS.length),
      issuedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.expiresAt <= value.issuedAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Credential expiry must follow issuance",
          path: ["expiresAt"],
        });
      }
      if (new Set(value.operations).size !== value.operations.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Credential operations must be unique",
          path: ["operations"],
        });
      }
    }),
);

/** Validated browser automation credential claims. */
export type BrowserAutomationCredentialClaims = z.infer<
  ReturnType<typeof BrowserAutomationCredentialClaimsSchema>
>;

const emptyArgs = z.object({}).strict();
const urlArgs = z.object({ url: BrowserAutomationUrlSchema() }).strict();
const timedTargetArgs = z
  .object({ target: BrowserAutomationTargetSchema(), timeoutMs: timeoutSchema })
  .strict();
const requestBase = {
  contractVersion: z.literal(BROWSER_AUTOMATION_CONTRACT_VERSION),
  workspaceId: idSchema,
  threadId: idSchema,
  providerSessionId: idSchema,
  providerInstanceId: idSchema,
  requestId: idSchema,
  sequence: z.number().int().nonnegative(),
  deadline: z.number().int().positive(),
  expectedControlEpoch: z.number().int().nonnegative(),
};

const requestVariant = <T extends BrowserAutomationOperation>(
  operation: T,
  args: z.ZodTypeAny,
) => z.object({ ...requestBase, operation: z.literal(operation), args }).strict();

/** Versioned, scoped request envelope for every browser operation. */
export const BrowserAutomationRequestSchema = lazySchema(() =>
  z.discriminatedUnion("operation", [
    requestVariant("status", emptyArgs),
    requestVariant(
      "open",
      z.object({ url: BrowserAutomationUrlSchema().optional(), activate: z.boolean().default(true) }).strict(),
    ),
    requestVariant("navigate", urlArgs),
    requestVariant(
      "resize",
      z.object({ width: z.number().int().min(320).max(7_680), height: z.number().int().min(240).max(4_320) }).strict(),
    ),
    requestVariant(
      "snapshot",
      z.object({ includeScreenshot: z.boolean().default(true), timeoutMs: timeoutSchema }).strict(),
    ),
    requestVariant(
      "screenshot",
      z.object({ maxWidth: z.number().int().positive().max(BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH).default(BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH), fullPage: z.boolean().default(false) }).strict(),
    ),
    requestVariant(
      "click",
      timedTargetArgs.extend({ button: z.enum(["left", "middle", "right"]).default("left"), clickCount: z.number().int().min(1).max(3).default(1) }).strict(),
    ),
    requestVariant(
      "type",
      z.object({ target: BrowserAutomationTargetSchema().optional(), text: z.string().max(BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS), clear: z.boolean().default(false), submit: z.boolean().default(false), timeoutMs: timeoutSchema }).strict(),
    ),
    requestVariant(
      "press",
      z.object({ key: z.string().min(1).max(64), modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).default([]), timeoutMs: timeoutSchema }).strict(),
    ),
    requestVariant(
      "scroll",
      z.object({ target: BrowserAutomationTargetSchema().optional(), deltaX: z.number().finite().min(-100_000).max(100_000).default(0), deltaY: z.number().finite().min(-100_000).max(100_000), timeoutMs: timeoutSchema }).strict(),
    ),
    requestVariant(
      "waitFor",
      z.union([
        timedTargetArgs.extend({ state: z.enum(["attached", "visible", "hidden", "detached"]).default("visible") }).strict(),
        z.object({ url: BrowserAutomationUrlSchema(), timeoutMs: timeoutSchema }).strict(),
        z.object({ text: z.string().min(1).max(SHORT_TEXT_MAX), timeoutMs: timeoutSchema }).strict(),
      ]),
    ),
    requestVariant(
      "console",
      z.object({ levels: z.array(z.enum(["debug", "info", "warning", "error"])).max(4).optional(), source: BrowserAutomationDiagnosticLocationSchema().optional(), limit: z.number().int().min(1).max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES).default(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES), clear: z.never().optional() }).strict(),
    ),
    requestVariant(
      "network",
      z.object({ failedOnly: z.boolean().default(false), limit: z.number().int().min(1).max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES).default(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES), clear: z.never().optional() }).strict(),
    ),
    requestVariant(
      "accessibility",
      z.object({ root: BrowserAutomationTargetSchema().optional(), limit: z.number().int().min(1).max(BROWSER_AUTOMATION_MAX_AX_NODES).default(BROWSER_AUTOMATION_MAX_AX_NODES) }).strict(),
    ),
    requestVariant(
      "performance",
      z.object({ includeMemory: z.boolean().default(true) }).strict(),
    ),
    requestVariant(
      "evaluate",
      z.object({ expression: z.string().min(1).refine((value) => utf8Length(value) <= BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES, "Expression exceeds 64 KiB"), awaitPromise: z.boolean().default(true), timeoutMs: timeoutSchema }).strict(),
    ),
    requestVariant(
      "recordingStart",
      z.object({ maxDurationMs: z.number().int().min(1_000).max(RECORDING_MAX_DURATION_MS).default(RECORDING_MAX_DURATION_MS) }).strict(),
    ),
    requestVariant("recordingStop", emptyArgs),
  ]),
);

/** Any validated browser automation request. */
export type BrowserAutomationRequest = z.infer<ReturnType<typeof BrowserAutomationRequestSchema>>;

const actionResultFields = {
  url: BrowserAutomationOutputLocationSchema(),
  title: z.string().max(4_096),
  controlEpoch: z.number().int().nonnegative(),
};
const actionResult = <T extends BrowserAutomationOperation>(operation: T) =>
  z.object({ operation: z.literal(operation), ...actionResultFields }).strict();

/** Exhaustive operation-specific browser success result. */
export const BrowserAutomationResultSchema = lazySchema(() =>
  z.discriminatedUnion("operation", [
    z.object({
      operation: z.literal("status"),
      available: z.boolean(),
      active: z.boolean(),
      tabId: idSchema.optional(),
      url: BrowserAutomationOutputLocationSchema(),
      loading: z.boolean(),
      focused: z.boolean(),
      viewport: z.object({ width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000) }).strict(),
      controller: BrowserAutomationControllerStateSchema().optional(),
      capabilities: z.array(z.enum(BROWSER_AUTOMATION_OPERATIONS)).max(BROWSER_AUTOMATION_OPERATIONS.length),
    }).strict(),
    actionResult("open"),
    actionResult("navigate"),
    z.object({ operation: z.literal("resize"), width: z.number().int().positive(), height: z.number().int().positive(), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("snapshot"), snapshot: BrowserAutomationSnapshotSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("screenshot"), screenshot: BrowserAutomationScreenshotSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
    actionResult("click"),
    actionResult("type"),
    actionResult("press"),
    actionResult("scroll"),
    actionResult("waitFor"),
    z.object({ operation: z.literal("console"), entries: z.array(BrowserAutomationConsoleEntrySchema()).max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES), truncation: BrowserAutomationTruncationSchema() }).strict(),
    z.object({ operation: z.literal("network"), entries: z.array(BrowserAutomationNetworkEntrySchema()).max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES), truncation: BrowserAutomationTruncationSchema() }).strict(),
    z.object({ operation: z.literal("accessibility"), nodes: z.array(BrowserAutomationAccessibilityNodeSchema()).max(BROWSER_AUTOMATION_MAX_AX_NODES), truncation: BrowserAutomationTruncationSchema() }).strict(),
    z.object({ operation: z.literal("performance"), metrics: BrowserAutomationPerformanceMetricsSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("evaluate"), valueJson: z.string().refine((value) => utf8Length(value) <= BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES, "Evaluation result exceeds 64 KiB"), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("recordingStart"), recordingId: idSchema, startedAt: z.number().int().nonnegative(), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("recordingStop"), recordingId: idSchema, mediaType: z.literal("video/webm"), dataBase64: z.string().max(RECORDING_MAX_BASE64_CHARS).refine((value) => { const size = decodedBase64Size(value); return size !== null && size <= BROWSER_AUTOMATION_MAX_RECORDING_BYTES; }, "Recording must be valid base64 within 512 KiB decoded"), durationMs: z.number().int().nonnegative().max(RECORDING_MAX_DURATION_MS), truncation: BrowserAutomationTruncationSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
  ]).superRefine((value, context) => {
    if (value.operation === "console" || value.operation === "network") {
      validateTruncation(value.truncation, value.entries.length, context, ["truncation"]);
    } else if (value.operation === "accessibility") {
      validateTruncation(value.truncation, value.nodes.length, context, ["truncation"]);
    } else if (value.operation === "recordingStop") {
      validateTruncation(
        value.truncation,
        decodedBase64Size(value.dataBase64) ?? 0,
        context,
        ["truncation"],
      );
    }
  }),
);

/** Any validated operation-specific browser success result. */
export type BrowserAutomationResult = z.infer<ReturnType<typeof BrowserAutomationResultSchema>>;

/** Stable browser automation error codes returned across process boundaries. */
export const BROWSER_AUTOMATION_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "UNSUPPORTED_OPERATION",
  "HOST_UNAVAILABLE",
  "TAB_UNAVAILABLE",
  "DEBUGGER_CONFLICT",
  "STALE_TARGET_GENERATION",
  "STALE_CONTROL_EPOCH",
  "HUMAN_INTERRUPTED",
  "OPERATION_CANCELLED",
  "TIMEOUT",
  "DEADLINE_EXCEEDED",
  "TARGET_NOT_FOUND",
  "NAVIGATION_FAILED",
  "RESULT_TOO_LARGE",
  "RECORDING_NOT_ACTIVE",
  "INTERNAL_ERROR",
] as const;

/** One stable browser automation error code. */
export type BrowserAutomationErrorCode = (typeof BROWSER_AUTOMATION_ERROR_CODES)[number];

/** Structured browser automation failure safe to expose to a provider. */
export const BrowserAutomationErrorSchema = lazySchema(() =>
  z
    .object({
      code: z.enum(BROWSER_AUTOMATION_ERROR_CODES),
      message: z.string().min(1).max(SHORT_TEXT_MAX),
      retryable: z.boolean(),
    })
    .strict(),
);

/** Structured browser automation failure. */
export type BrowserAutomationError = z.infer<ReturnType<typeof BrowserAutomationErrorSchema>>;

/** Exhaustive success or error response envelope for browser requests. */
export const BrowserAutomationResponseSchema = lazySchema(() =>
  z
    .discriminatedUnion("ok", [
      z
        .object({
          contractVersion: z.literal(BROWSER_AUTOMATION_CONTRACT_VERSION),
          requestId: idSchema,
          sequence: z.number().int().nonnegative(),
          ok: z.literal(true),
          result: BrowserAutomationResultSchema(),
        })
        .strict(),
      z
        .object({
          contractVersion: z.literal(BROWSER_AUTOMATION_CONTRACT_VERSION),
          requestId: idSchema,
          sequence: z.number().int().nonnegative(),
          ok: z.literal(false),
          error: BrowserAutomationErrorSchema(),
        })
        .strict(),
    ])
    .refine(
      (value) => hasBoundedJsonSize(value, BROWSER_AUTOMATION_MAX_RESULT_BYTES),
      "Browser automation response exceeds 512 KiB",
    ),
);

/** Any validated browser automation response. */
export type BrowserAutomationResponse = z.infer<ReturnType<typeof BrowserAutomationResponseSchema>>;
