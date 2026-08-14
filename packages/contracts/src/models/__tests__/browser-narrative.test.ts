import { describe, expect, it } from "vitest";
import {
  projectBrowserNarrativeInput,
  projectBrowserNarrativeResult,
  resolveBrowserNarrativeTool,
  serializeBrowserNarrativeResult,
} from "../browser-narrative.js";

describe("Browser narrative projection", () => {
  it.each([
    ["browser_open", "browser_open"],
    ["mcp__mcode-browser__browser_inspect", "browser_inspect"],
    ["mcp:mcode-browser:browser_act", "browser_act"],
    ["mcode-browser.browser_tabs", "browser_tabs"],
    ["MCP__MCODE-BROWSER__BROWSER_EVALUATE", "browser_evaluate"],
  ])("resolves %s", (toolName, expected) => {
    expect(resolveBrowserNarrativeTool(toolName)).toBe(expected);
  });

  it.each([
    "browser_status",
    "browser_navigate",
    "browser_snapshot",
    "browser_screenshot",
    "browser_click",
    "browser_recording_start",
  ])("does not resolve retired tool %s", (toolName) => {
    expect(resolveBrowserNarrativeTool(toolName)).toBeNull();
  });

  it("keeps only action identity and resize dimensions from Browser input", () => {
    const input = projectBrowserNarrativeInput("mcp__mcode-browser__browser_act", {
      observationRef: "SECRET_OBSERVATION",
      idempotencyKey: "SECRET_KEY",
      steps: [
        { operation: "type", text: "SECRET_TYPED_VALUE", target: { accessibleName: "Password" } },
        { operation: "navigate", url: "https://example.test/?token=SECRET_TOKEN" },
        { operation: "resize", width: 390, height: 844 },
      ],
    });

    expect(input).toEqual({
      operation: "browser_act",
      steps: [
        { operation: "type" },
        { operation: "navigate" },
        { operation: "resize", width: 390, height: 844 },
      ],
    });
    expect(JSON.stringify(input)).not.toContain("SECRET");
    expect(JSON.stringify(input)).not.toContain("Password");
  });

  it("keeps typed receipts and drops Browser result content", () => {
    const result = projectBrowserNarrativeResult(
      "mcp__mcode-browser__browser_act",
      JSON.stringify({
        operation: "act",
        outcome: "interrupted",
        effect: "partial",
        recovery: "yield_to_user",
        receipts: [
          { index: 0, operation: "click", status: "applied", message: "SECRET_PAGE_TEXT" },
          { index: 1, operation: "type", status: "interrupted", message: "SECRET_TYPED_VALUE" },
        ],
        finalObservation: { visibleText: "SECRET_BODY" },
        nextObservationRef: "SECRET_OBSERVATION",
      }),
      false,
    );

    expect(result).toEqual({
      operation: "browser_act",
      outcome: "interrupted",
      effect: "partial",
      recovery: "yield_to_user",
      receipts: [
        { index: 0, operation: "click", status: "applied" },
        { index: 1, operation: "type", status: "interrupted" },
      ],
    });
    expect(serializeBrowserNarrativeResult(result!)).not.toContain("SECRET");
  });

  it("reduces inspection output to readiness and bounded counts", () => {
    const result = projectBrowserNarrativeResult("browser_inspect", JSON.stringify({
      operation: "inspect",
      readiness: { ready: true, state: "ready", reason: "SECRET_REASON" },
      tabs: [{ tabId: "SECRET_TAB", url: "https://example.test/?token=SECRET" }],
      capabilities: ["inspect", "act"],
      snapshot: { visibleText: "SECRET_BODY" },
      diagnostics: ["SECRET_DIAGNOSTIC"],
    }), false);

    expect(result).toEqual({
      operation: "browser_inspect",
      outcome: "completed",
      readiness: "ready",
      tabCount: 1,
      capabilityCount: 2,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("keeps only allowlisted recovery metadata from Browser errors", () => {
    const result = projectBrowserNarrativeResult("browser_act", JSON.stringify({
      code: "STALE_TARGET_GENERATION",
      message: "SECRET_PAGE_DETAILS",
      retryable: true,
      recovery: "inspect",
      correlationId: "SECRET_CORRELATION",
    }), true);

    expect(result).toEqual({
      operation: "browser_act",
      outcome: "failed",
      recovery: "inspect",
      errorCode: "STALE_TARGET_GENERATION",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("projects nested MCP Browser errors as failed outcomes", () => {
    const result = projectBrowserNarrativeResult(
      "browser_act",
      JSON.stringify({
        ok: false,
        error: {
          code: "UNSUPPORTED_OPERATION",
          effect: "none",
          recovery: "inspect",
          message: "SECRET_DETAILS",
        },
      }),
      false,
    );

    expect(result).toEqual({
      operation: "browser_act",
      outcome: "failed",
      effect: "none",
      recovery: "inspect",
      errorCode: "UNSUPPORTED_OPERATION",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("does not project unrelated tools", () => {
    expect(projectBrowserNarrativeInput("Read", { text: "SECRET" })).toBeNull();
    expect(projectBrowserNarrativeResult("Read", "SECRET", false)).toBeNull();
  });
});
