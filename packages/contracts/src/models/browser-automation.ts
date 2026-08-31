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
/** Minimum CSS viewport dimension accepted by browser resize operations. */
export const BROWSER_AUTOMATION_MIN_VIEWPORT_PX = 240;
/** Maximum CSS viewport dimension accepted by browser resize operations. */
export const BROWSER_AUTOMATION_MAX_VIEWPORT_PX = 2_560;
/** Total CSS-pixel inset reserved around a responsive viewport canvas frame. */
export const BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX = 64;
/** Allowed responsive viewport presentation modes for Browser surfaces. */
export const BROWSER_AUTOMATION_VIEWPORT_PRESENTATIONS = [
  "fit",
  "actual",
  "50%",
  "75%",
  "100%",
  "125%",
  "150%",
  "200%",
] as const;
/** One responsive viewport presentation mode. */
export type BrowserAutomationViewportPresentation =
  (typeof BROWSER_AUTOMATION_VIEWPORT_PRESENTATIONS)[number];

/** Resolve a fixed viewport presentation scale, or null when Fit owns the scale. */
export function resolveBrowserAutomationViewportPresentationScale(
  presentation: BrowserAutomationViewportPresentation,
): number | null {
  if (presentation === "fit") return null;
  if (presentation === "actual") return 1;
  return Number.parseInt(presentation, 10) / 100;
}

/** Maximum encoded success result size in bytes. */
export const BROWSER_AUTOMATION_MAX_RESULT_BYTES = 512 * 1_024;
/** Maximum decoded browser recording size in bytes. */
export const BROWSER_AUTOMATION_MAX_RECORDING_BYTES = 512 * 1_024;
/** Maximum requests a browser host may process or queue concurrently. */
export const BROWSER_AUTOMATION_MAX_PENDING_REQUESTS = 32;
/** Maximum text characters accepted by a type operation. */
export const BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS = 16_384;
/** Maximum ordered mutations accepted by browser_act. */
export const BROWSER_AUTOMATION_ACT_MAX_STEPS = 8;

/** Explicit opt-in environment flag for registration by the pure web runtime. */
export const BROWSER_AUTOMATION_WEB_DEV_FLAG = "MCODE_WEB_AUTOMATION" as const;

const ID_MAX = 256;
const SHORT_TEXT_MAX = 1_024;
const SELECTOR_MAX = 4_096;
const RECORDING_MAX_DURATION_MS = 10 * 60_000;
const RECORDING_MAX_BASE64_CHARS =
  Math.ceil(BROWSER_AUTOMATION_MAX_RECORDING_BYTES / 3) * 4;

const idSchema = z.string().trim().min(1).max(ID_MAX);
const idempotencyKeySchema = z.string().trim().min(1).max(ID_MAX);
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

/** Browser v2 operations exposed to provider-neutral automation clients. */
export const BROWSER_AUTOMATION_OPERATIONS = [
  "open",
  "inspect",
  "act",
  "tabs",
  "evaluate",
] as const;

/** Internal Browser host operations retained for visible-surface execution. */
export const BROWSER_AUTOMATION_HOST_OPERATIONS = [
  "status",
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
  "recordingStart",
  "recordingStop",
] as const;

/** Internal Browser step operations dispatched by browser_act. */
export const BROWSER_AUTOMATION_INTERNAL_OPERATIONS = [
  "back",
  "forward",
  "reload",
  "wait",
] as const;

/** Stable Browser v2 operations discoverable during transient unavailability. */
export const BROWSER_V2_CORE_OPERATIONS = ["open", "inspect", "act", "tabs"] as const;

/** One provider-visible Browser v2 operation identifier. */
export type BrowserAutomationPublicOperation = (typeof BROWSER_AUTOMATION_OPERATIONS)[number];
/** One Browser operation used by the host transport and visible-surface executor. */
export type BrowserAutomationOperation =
  | BrowserAutomationPublicOperation
  | (typeof BROWSER_AUTOMATION_HOST_OPERATIONS)[number];
/** Browser operation accepted by the host dispatch boundary, including act-step mechanics. */
export type BrowserAutomationRequestOperation =
  | BrowserAutomationOperation
  | (typeof BROWSER_AUTOMATION_INTERNAL_OPERATIONS)[number];
const browserRequestOperationSchema = z.union([
  z.enum(BROWSER_AUTOMATION_OPERATIONS),
  z.enum(BROWSER_AUTOMATION_HOST_OPERATIONS),
  z.enum(BROWSER_AUTOMATION_INTERNAL_OPERATIONS),
]);
const browserPublicOperationSchema = z.enum(BROWSER_AUTOMATION_OPERATIONS);
const browserHostOperationSchema = z.union([
  z.enum(BROWSER_AUTOMATION_OPERATIONS),
  z.enum(BROWSER_AUTOMATION_HOST_OPERATIONS),
]);

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
  readonly operation: BrowserAutomationPublicOperation;
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
/** Exhaustive MCP names and safety annotations for Browser v2 operations. */
export const BROWSER_AUTOMATION_OPERATION_METADATA = {
  open: {
    operation: "open",
    mcpName: "browser_open",
    annotations: { ...input, openWorld: true },
  },
  inspect: { operation: "inspect", mcpName: "browser_inspect", annotations: readOnly },
  act: { operation: "act", mcpName: "browser_act", annotations: input },
  tabs: { operation: "tabs", mcpName: "browser_tabs", annotations: { ...input, idempotent: true } },
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
} satisfies Record<BrowserAutomationPublicOperation, BrowserAutomationOperationMetadata>;

/** Maximum tabs returned by one browser_inspect response. */
export const BROWSER_AUTOMATION_MAX_INSPECT_TABS = 32;
/** Maximum generated guidance characters returned by browser_inspect. */
export const BROWSER_AUTOMATION_MAX_GUIDANCE_CHARS = 4_000;

/** Canonical runtime executor descriptor shared by registration and inspection. */
export const BrowserAutomationExecutorDescriptorSchema = lazySchema(() =>
  z.object({
    runtime: BrowserAutomationHostRuntimeSchema,
    operations: z.array(browserHostOperationSchema).max(BROWSER_AUTOMATION_OPERATIONS.length + BROWSER_AUTOMATION_HOST_OPERATIONS.length),
    constraints: z.object({
      maxTabs: z.number().int().positive().max(BROWSER_AUTOMATION_MAX_INSPECT_TABS),
      maxSnapshotChars: z.number().int().positive().max(BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS),
      maxDiagnostics: z.number().int().positive().max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
    }).strict(),
    capabilityRevision: z.number().int().positive(),
  }).strict(),
);
/** Canonical runtime executor descriptor type. */
export type BrowserAutomationExecutorDescriptor = z.infer<ReturnType<typeof BrowserAutomationExecutorDescriptorSchema>>;

/** Bounded sticky target summary returned by browser_inspect. */
export const BrowserAutomationInspectTargetSchema = lazySchema(() => z.object({
  threadId: idSchema,
  tabId: idSchema,
  targetGeneration: z.number().int().nonnegative(),
  sticky: z.literal(true),
}).strict());

/** Bounded readiness state returned by browser_inspect. */
export const BrowserAutomationInspectReadinessSchema = lazySchema(() => z.object({
  ready: z.boolean(),
  state: z.enum(["ready", "host-unavailable", "target-unavailable", "recovering", "human-control"]),
  reason: z.string().max(SHORT_TEXT_MAX).optional(),
}).strict());

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
    .superRefine(validateDiagnosticLocation),
);

function validateDiagnosticLocation(value: string, context: z.RefinementCtx): void {
  const parsed = parseDiagnosticLocation(value, context);
  if (!parsed) return;
  validateDiagnosticUrl(parsed, value, context);
  if (parsed.protocol === "blob:") validateBlobDiagnosticLocation(value, context);
}

function parseDiagnosticLocation(value: string, context: z.RefinementCtx): URL | null {
  try {
    return new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid diagnostic location" });
    return null;
  }
}

function validateDiagnosticUrl(value: URL, rawValue: string, context: z.RefinementCtx): void {
  if (!diagnosticSchemes.has(value.protocol)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Diagnostic location scheme is not allowed" });
  }
  if (value.username || value.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Diagnostic locations cannot contain credentials" });
  }
  if (value.search || value.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Diagnostic locations cannot contain query or fragment data" });
  }
  if (value.protocol === "data:" && rawValue !== "data:[redacted]") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Data diagnostic locations must be redacted" });
  }
}

function validateBlobDiagnosticLocation(value: string, context: z.RefinementCtx): void {
  try {
    const inner = new URL(value.slice("blob:".length));
    if (inner.username || inner.password || inner.search || inner.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Blob diagnostic locations must contain a sanitized origin",
      });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Blob diagnostic location is invalid" });
  }
}

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
      operation: browserRequestOperationSchema,
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
      operation: browserRequestOperationSchema.optional(),
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
      operation: browserHostOperationSchema,
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
      executorDescriptor: BrowserAutomationExecutorDescriptorSchema(),
      capabilities: z
        .array(BrowserAutomationHostCapabilitySchema())
        .min(1)
        .max(BROWSER_AUTOMATION_OPERATIONS.length + BROWSER_AUTOMATION_HOST_OPERATIONS.length),
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
      controller: BrowserAutomationControllerStateSchema().optional(),
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
          capabilityRevision: z.number().int().positive().optional(),
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
        .array(browserPublicOperationSchema)
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
const requestVariantBaseSchema = z.object(requestBase).strict();

const actTarget = z.object({ target: BrowserAutomationTargetSchema() }).strict();
const actTimeout = z.number().int().min(1).max(BROWSER_AUTOMATION_MAX_TIMEOUT_MS).optional();

/** One bounded mutation admitted by browser_act. */
export const BrowserAutomationActStepSchema = lazySchema(() => z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("navigate"), url: BrowserAutomationUrlSchema() }).strict(),
  z.object({ operation: z.literal("back") }).strict(),
  z.object({ operation: z.literal("forward") }).strict(),
  z.object({ operation: z.literal("reload") }).strict(),
  z.object({ operation: z.literal("resize"), width: z.number().int().min(BROWSER_AUTOMATION_MIN_VIEWPORT_PX).max(BROWSER_AUTOMATION_MAX_VIEWPORT_PX), height: z.number().int().min(BROWSER_AUTOMATION_MIN_VIEWPORT_PX).max(BROWSER_AUTOMATION_MAX_VIEWPORT_PX) }).strict(),
  z.object({ operation: z.literal("hover"), ...actTarget.shape, timeoutMs: actTimeout }).strict(),
  z.object({ operation: z.literal("click"), ...actTarget.shape, button: z.enum(["left", "middle", "right"]).default("left"), clickCount: z.literal(2).or(z.literal(1)).default(1), timeoutMs: actTimeout }).strict(),
  z.object({ operation: z.literal("drag"), source: BrowserAutomationTargetSchema(), target: BrowserAutomationTargetSchema(), timeoutMs: actTimeout }).strict(),
  z.object({ operation: z.literal("type"), target: BrowserAutomationTargetSchema().optional(), text: z.string().max(BROWSER_AUTOMATION_MAX_TYPED_TEXT_CHARS), clear: z.boolean().default(false), submit: z.boolean().default(false), timeoutMs: actTimeout }).strict(),
  z.object({ operation: z.literal("press"), key: z.string().min(1).max(64), modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).default([]), timeoutMs: actTimeout }).strict(),
  z.object({ operation: z.literal("scroll"), target: BrowserAutomationTargetSchema().optional(), deltaX: z.number().finite().min(-100_000).max(100_000).default(0), deltaY: z.number().finite().min(-100_000).max(100_000), timeoutMs: actTimeout }).strict(),
  z.object({ operation: z.literal("wait"), durationMs: z.number().int().min(1).max(BROWSER_AUTOMATION_MAX_TIMEOUT_MS) }).strict(),
  z.object({ operation: z.literal("assert"), target: BrowserAutomationTargetSchema().optional(), text: z.string().min(1).max(SHORT_TEXT_MAX).optional(), url: BrowserAutomationUrlSchema().optional() }).strict(),
  z.object({ operation: z.literal("recordingStart") }).strict(),
  z.object({ operation: z.literal("recordingStop") }).strict(),
]).superRefine((value, context) => {
  if (value.operation === "assert" && value.target === undefined && value.text === undefined && value.url === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Assert requires target, text, or url", path: ["assert"] });
  }
}));
/** Typed bounded browser_act step. */
export type BrowserAutomationActStep = z.infer<ReturnType<typeof BrowserAutomationActStepSchema>>;

/** Observation revisions bound to a visible Preview before mutation. */
export const BrowserAutomationObservationBindingSchema = lazySchema(() => z.object({
  observationRef: idSchema,
  hostRevision: z.number().int().nonnegative(),
  documentRevision: z.number().int().nonnegative(),
  controlRevision: z.number().int().nonnegative(),
  capabilityRevision: z.number().int().positive(),
  observationRevision: z.number().int().nonnegative(),
}).strict());
/** Typed observation binding. */
export type BrowserAutomationObservationBinding = z.infer<ReturnType<typeof BrowserAutomationObservationBindingSchema>>;

const mutationArgs = {
  idempotencyKey: idempotencyKeySchema,
  observationRef: idSchema,
  deadlineMs: z.number().int().min(1).max(BROWSER_AUTOMATION_MAX_TIMEOUT_MS),
} as const;

const actArgs = z.object({
  ...mutationArgs,
  steps: z.array(BrowserAutomationActStepSchema()).min(1).max(BROWSER_AUTOMATION_ACT_MAX_STEPS),
}).strict();

const tabsMutationBase = {
  idempotencyKey: idempotencyKeySchema,
  observationRef: idSchema,
};

const tabsArgs = z.union([
  z.object({ ...tabsMutationBase, action: z.literal("select"), tabId: idSchema }).strict(),
  z.object({ ...tabsMutationBase, action: z.literal("claim"), tabId: idSchema }).strict(),
  z.object({ ...tabsMutationBase, action: z.literal("release"), tabId: idSchema.optional() }).strict(),
  z.object({ ...tabsMutationBase, action: z.literal("close"), tabId: idSchema.optional() }).strict(),
  z.object({
    ...tabsMutationBase,
    action: z.literal("finalize"),
    dispositions: z.array(z.object({
      tabId: idSchema,
      disposition: z.enum(["close", "release", "handoff", "deliverable"]),
    }).strict()).max(BROWSER_AUTOMATION_MAX_INSPECT_TABS),
  }).strict().superRefine((value, context) => {
    if (new Set(value.dispositions.map((entry) => entry.tabId)).size !== value.dispositions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Browser tab dispositions must identify unique tabs",
        path: ["dispositions"],
      });
    }
  }),
]);

/** One explicit Browser tab lifecycle mutation. */
export const BrowserAutomationTabsArgsSchema = lazySchema(() => tabsArgs);
/** Typed Browser tab lifecycle mutation. */
export type BrowserAutomationTabsArgs = z.infer<ReturnType<typeof BrowserAutomationTabsArgsSchema>>;

const requestVariant = <T extends BrowserAutomationRequestOperation>(
  operation: T,
  args: z.ZodTypeAny,
) => requestVariantBaseSchema.extend({ operation: z.literal(operation), args });

/** Versioned, scoped request envelope for every browser operation. */
export const BrowserAutomationRequestSchema = lazySchema(() =>
  z.discriminatedUnion("operation", [
    requestVariant("inspect", z.object({
      includeScreenshot: z.boolean().default(false),
      includeDiagnostics: z.boolean().default(false),
    }).strict()),
    requestVariant("status", emptyArgs),
    requestVariant(
      "open",
      z.object({
        url: BrowserAutomationUrlSchema().optional(),
        // `activate` is retained as an ignored wire field for older clients;
        // BrowserSessionDriver never uses it to change visible selection.
        activate: z.boolean().optional(),
        idempotencyKey: idempotencyKeySchema.optional(),
      }).strict(),
    ),
    requestVariant("navigate", urlArgs),
    requestVariant("back", emptyArgs),
    requestVariant("forward", emptyArgs),
    requestVariant("reload", emptyArgs),
    requestVariant(
      "resize",
      z.object({ width: z.number().int().min(BROWSER_AUTOMATION_MIN_VIEWPORT_PX).max(BROWSER_AUTOMATION_MAX_VIEWPORT_PX), height: z.number().int().min(BROWSER_AUTOMATION_MIN_VIEWPORT_PX).max(BROWSER_AUTOMATION_MAX_VIEWPORT_PX) }).strict(),
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
    requestVariant("wait", z.object({ durationMs: z.number().int().min(1).max(BROWSER_AUTOMATION_MAX_TIMEOUT_MS) }).strict()),
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
      z.object({
        ...mutationArgs,
        expression: z.string().min(1).refine((value) => utf8Length(value) <= BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES, "Expression exceeds 64 KiB"),
        awaitPromise: z.boolean().default(true),
        timeoutMs: timeoutSchema,
      }).strict(),
    ),
    requestVariant(
      "recordingStart",
      z.object({ maxDurationMs: z.number().int().min(1_000).max(RECORDING_MAX_DURATION_MS).default(RECORDING_MAX_DURATION_MS) }).strict(),
    ),
    requestVariant("recordingStop", emptyArgs),
    requestVariant("act", actArgs),
    requestVariant("tabs", tabsArgs),
  ]),
);

/** Any validated browser automation request. */
export type BrowserAutomationRequest = z.infer<ReturnType<typeof BrowserAutomationRequestSchema>>;

const actionResultFields = {
  url: BrowserAutomationOutputLocationSchema(),
  title: z.string().max(4_096),
  controlEpoch: z.number().int().nonnegative(),
};
const actionResultBaseSchema = z.object({ operation: z.never(), ...actionResultFields }).strict();
const actionResult = <T extends BrowserAutomationRequestOperation>(operation: T) =>
  actionResultBaseSchema.extend({ operation: z.literal(operation) });

/** One content-free receipt for a bounded Browser mutation step. */
export const BrowserAutomationMutationReceiptSchema = lazySchema(() => z.object({
  index: z.number().int().nonnegative(),
  operation: z.string().min(1).max(32),
  status: z.enum(["applied", "satisfied", "failed", "interrupted", "skipped"]),
  message: z.string().max(SHORT_TEXT_MAX).optional(),
}).strict());
/** Typed content-free receipt for a bounded Browser mutation step. */
export type BrowserAutomationMutationReceipt = z.infer<ReturnType<typeof BrowserAutomationMutationReceiptSchema>>;

/** Structured result for one bounded browser_act batch. */
export const BrowserAutomationActResultSchema = lazySchema(() => z.object({
  operation: z.literal("act"),
  outcome: z.enum(["completed", "failed", "interrupted"]),
  stoppingPosition: z.number().int().nonnegative(),
  effect: z.enum(["none", "partial", "complete"]),
  recovery: z.enum(["inspect", "reopen", "wait", "yield_to_user", "do_not_retry"]),
  receipts: z.array(BrowserAutomationMutationReceiptSchema()).max(BROWSER_AUTOMATION_ACT_MAX_STEPS),
  finalObservation: BrowserAutomationObservationBindingSchema(),
  nextObservationRef: idSchema.optional(),
}).strict());
/** Typed browser_act result. */
export type BrowserAutomationActResult = z.infer<ReturnType<typeof BrowserAutomationActResultSchema>>;

/** Structured result for one privileged browser_evaluate mutation. */
export const BrowserAutomationEvaluateResultSchema = lazySchema(() => z.object({
  operation: z.literal("evaluate"),
  outcome: z.enum(["completed", "failed", "interrupted"]),
  stoppingPosition: z.number().int().min(0).max(1),
  effect: z.enum(["none", "partial", "complete"]),
  recovery: z.enum(["inspect", "reopen", "wait", "yield_to_user", "do_not_retry"]),
  receipts: z.array(BrowserAutomationMutationReceiptSchema()).length(1),
  finalObservation: BrowserAutomationObservationBindingSchema(),
  nextObservationRef: idSchema.optional(),
  valueJson: z.string().refine((value) => utf8Length(value) <= BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES, "Evaluation result exceeds 64 KiB").optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "completed" && value.valueJson === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Completed evaluation requires a bounded result",
      path: ["valueJson"],
    });
  }
}));
/** Typed browser_evaluate mutation result. */
export type BrowserAutomationEvaluateResult = z.infer<ReturnType<typeof BrowserAutomationEvaluateResultSchema>>;

/** Normalized ownership state for one tab controlled by a provider session. */
export const BrowserAutomationOwnedTabSchema = lazySchema(() => z.object({
  tabId: idSchema,
  provenance: z.enum(["agent-created", "claimed-user"]),
  ownership: z.enum(["owned", "claimed", "released"]),
  disposition: z.enum(["close", "release", "handoff", "deliverable"]).optional(),
}).strict());
/** Typed normalized Browser tab ownership state. */
export type BrowserAutomationOwnedTab = z.infer<ReturnType<typeof BrowserAutomationOwnedTabSchema>>;

/** Structured result for one browser_tabs lifecycle mutation. */
export const BrowserAutomationTabsResultSchema = lazySchema(() => z.object({
  operation: z.literal("tabs"),
  action: z.enum(["select", "claim", "release", "close", "finalize"]),
  currentTabId: idSchema.optional(),
  observationRef: idSchema.optional(),
  tabs: z.array(BrowserAutomationOwnedTabSchema()).max(BROWSER_AUTOMATION_MAX_INSPECT_TABS),
}).strict());
/** Typed browser_tabs result. */
export type BrowserAutomationTabsResult = z.infer<ReturnType<typeof BrowserAutomationTabsResultSchema>>;

/** Exhaustive operation-specific browser success result. */
export const BrowserAutomationResultSchema = lazySchema(() =>
  z.union([
    z.object({
      operation: z.literal("inspect"),
      readiness: BrowserAutomationInspectReadinessSchema().optional(),
      target: BrowserAutomationInspectTargetSchema().optional(),
      tabs: z.array(BrowserAutomationHostDispatchTargetSchema()).max(BROWSER_AUTOMATION_MAX_INSPECT_TABS),
      snapshot: BrowserAutomationSnapshotSchema().optional(),
      screenshot: BrowserAutomationScreenshotSchema().optional(),
      diagnostics: z.array(z.string().max(SHORT_TEXT_MAX)).max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES).optional(),
      observationRef: idSchema.optional(),
      capabilityRevision: z.number().int().positive().optional(),
      capabilities: z.array(browserPublicOperationSchema).max(BROWSER_AUTOMATION_OPERATIONS.length).optional(),
      guidance: z.string().max(BROWSER_AUTOMATION_MAX_GUIDANCE_CHARS).optional(),
    }).strict(),
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
      capabilities: z.array(browserHostOperationSchema).max(BROWSER_AUTOMATION_OPERATIONS.length + BROWSER_AUTOMATION_HOST_OPERATIONS.length).optional(),
      capabilityRevision: z.number().int().positive().optional(),
    }).strict(),
    z.object({
      operation: z.literal("open"),
      url: BrowserAutomationOutputLocationSchema(),
      title: z.string().max(4_096),
      controlEpoch: z.number().int().nonnegative(),
      observationRef: idSchema.optional(),
    }).strict(),
    actionResult("navigate"),
    actionResult("back"),
    actionResult("forward"),
    actionResult("reload"),
    z.object({ operation: z.literal("resize"), width: z.number().int().positive(), height: z.number().int().positive(), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("snapshot"), snapshot: BrowserAutomationSnapshotSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("screenshot"), screenshot: BrowserAutomationScreenshotSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
    actionResult("click"),
    actionResult("type"),
    actionResult("press"),
    actionResult("scroll"),
    actionResult("waitFor"),
    actionResult("wait"),
    z.object({ operation: z.literal("console"), entries: z.array(BrowserAutomationConsoleEntrySchema()).max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES), truncation: BrowserAutomationTruncationSchema() }).strict(),
    z.object({ operation: z.literal("network"), entries: z.array(BrowserAutomationNetworkEntrySchema()).max(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES), truncation: BrowserAutomationTruncationSchema() }).strict(),
    z.object({ operation: z.literal("accessibility"), nodes: z.array(BrowserAutomationAccessibilityNodeSchema()).max(BROWSER_AUTOMATION_MAX_AX_NODES), truncation: BrowserAutomationTruncationSchema() }).strict(),
    z.object({ operation: z.literal("performance"), metrics: BrowserAutomationPerformanceMetricsSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
    // The Electron kernel returns this internal result to BrowserSessionDriver,
    // which wraps it in the public mutation envelope before broker delivery.
    z.object({ operation: z.literal("evaluate"), valueJson: z.string().refine((value) => utf8Length(value) <= BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES, "Evaluation result exceeds 64 KiB"), controlEpoch: z.number().int().nonnegative() }).strict(),
    BrowserAutomationEvaluateResultSchema(),
    z.object({ operation: z.literal("recordingStart"), recordingId: idSchema, startedAt: z.number().int().nonnegative(), controlEpoch: z.number().int().nonnegative() }).strict(),
    z.object({ operation: z.literal("recordingStop"), recordingId: idSchema, mediaType: z.literal("video/webm"), dataBase64: z.string().max(RECORDING_MAX_BASE64_CHARS).refine((value) => { const size = decodedBase64Size(value); return size !== null && size <= BROWSER_AUTOMATION_MAX_RECORDING_BYTES; }, "Recording must be valid base64 within 512 KiB decoded"), durationMs: z.number().int().nonnegative().max(RECORDING_MAX_DURATION_MS), truncation: BrowserAutomationTruncationSchema(), controlEpoch: z.number().int().nonnegative() }).strict(),
    BrowserAutomationActResultSchema(),
    BrowserAutomationTabsResultSchema(),
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
  "IDEMPOTENCY_CONFLICT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "UNSUPPORTED_OPERATION",
  "CROSS_ORIGIN",
  "HOST_UNAVAILABLE",
  "TAB_UNAVAILABLE",
  "DEBUGGER_CONFLICT",
  "STALE_TARGET_GENERATION",
  "CAPABILITY_CHANGED",
  "STALE_CONTROL_EPOCH",
  "HUMAN_INTERRUPTED",
  "OPERATION_CANCELLED",
  "TIMEOUT",
  "DEADLINE_EXCEEDED",
  "TARGET_NOT_FOUND",
  "CROSS_ORIGIN",
  "NAVIGATION_FAILED",
  "RESULT_TOO_LARGE",
  "RECORDING_NOT_ACTIVE",
  "INTERNAL_ERROR",
  "BROWSER_BUSY",
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
      appliedViewport: z.object({
        width: z.number().int().min(BROWSER_AUTOMATION_MIN_VIEWPORT_PX).max(BROWSER_AUTOMATION_MAX_VIEWPORT_PX),
        height: z.number().int().min(BROWSER_AUTOMATION_MIN_VIEWPORT_PX).max(BROWSER_AUTOMATION_MAX_VIEWPORT_PX),
      }).strict().optional(),
      stage: z.enum(["validation", "authorization", "allocation", "observation", "effect", "recovery", "transport"]).optional(),
      effect: z.enum(["none", "created", "closed", "preserved", "unknown"]).optional(),
      recovery: z.enum(["none", "retry", "refresh", "reopen", "manual", "inspect", "wait", "yield_to_user", "do_not_retry"]).optional(),
      correlationId: idSchema.optional(),
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
