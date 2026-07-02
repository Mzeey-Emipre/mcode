import { describe, it, expect } from "vitest";
import {
  AttachedBrowserCaptureSchema,
  clampAttachedBrowserCaptureForOutbound,
  clampMcodeBrowserCaptureV2,
  McodeBrowserCaptureV2Schema,
  MCODE_BROWSER_CAPTURE_V2_STRING_MAX,
  PREVIEW_ANNOTATION_STRING_MAX,
  type AttachedBrowserCaptureV2,
  type McodeBrowserCaptureV2,
} from "../browser-preview.js";

describe("browser capture clamp", () => {
  it("truncates v2 excerpt fields to schema max", () => {
    const cap = MCODE_BROWSER_CAPTURE_V2_STRING_MAX.headingOutline;
    const oversized = "A".repeat(cap + 500);
    const row: McodeBrowserCaptureV2 = {
      schemaVersion: 2,
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      capturedAt: "2026-05-08T12:00:00.000Z",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      headingOutline: oversized,
    };
    const clamped = clampMcodeBrowserCaptureV2(row);
    expect(clamped.headingOutline).toHaveLength(cap);
    expect(() => McodeBrowserCaptureV2Schema().parse(clamped)).not.toThrow();
  });

  it("truncates element style values and clamps opacity", () => {
    const row: McodeBrowserCaptureV2 = {
      schemaVersion: 2,
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      capturedAt: "2026-05-08T12:00:00.000Z",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      elementStyle: {
        textColor: "x".repeat(700),
        paddingLeft: "y".repeat(700),
        opacity: 2,
      },
    };
    const clamped = clampMcodeBrowserCaptureV2(row);
    expect(clamped.elementStyle?.textColor).toHaveLength(PREVIEW_ANNOTATION_STRING_MAX.visualValue);
    expect(clamped.elementStyle?.paddingLeft).toHaveLength(PREVIEW_ANNOTATION_STRING_MAX.visualValue);
    expect(clamped.elementStyle?.opacity).toBe(1);
    expect(() => McodeBrowserCaptureV2Schema().parse(clamped)).not.toThrow();
  });

  it("clampAttachedBrowserCaptureForOutbound makes oversized outbound rows parseable", () => {
    const cap = MCODE_BROWSER_CAPTURE_V2_STRING_MAX.consoleTail;
    const row: AttachedBrowserCaptureV2 = {
      attachmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      schemaVersion: 2,
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      capturedAt: "2026-05-08T12:00:00.000Z",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      consoleTail: "x".repeat(cap + 200),
    };
    const parsed = AttachedBrowserCaptureSchema().parse(clampAttachedBrowserCaptureForOutbound(row));
    expect(parsed.schemaVersion).toBe(2);
    if (parsed.schemaVersion === 2) {
      expect(parsed.consoleTail).toHaveLength(cap);
    }
  });
});
