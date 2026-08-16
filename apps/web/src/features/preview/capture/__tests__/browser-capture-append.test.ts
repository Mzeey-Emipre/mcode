import { describe, it, expect } from "vitest";
import { appendBrowserCaptureFence, MCODE_BROWSER_CAPTURE_FENCE_CLOSE, MCODE_BROWSER_CAPTURE_FENCE_OPEN } from "../browser-capture-append";
import {
  AttachedBrowserCaptureSchema,
  MCODE_BROWSER_CAPTURE_V2_STRING_MAX,
  type AttachedBrowserCaptureV1,
  type AttachedBrowserCaptureV2,
} from "@mcode/contracts";

const sampleCaptureV2: AttachedBrowserCaptureV2 = {
  attachmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  schemaVersion: 2,
  pageUrl: "https://example.com/path",
  pageTitle: "Example",
  capturedAt: "2026-05-08T12:00:00.000Z",
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  visibleTextExcerpt: "Hello world",
  headingOutline: "H1: Title",
  failedRequests: [{ url: "https://example.com/missing.css", statusCode: 404, resourceType: "stylesheet" }],
};

const sampleCaptureV1: AttachedBrowserCaptureV1 = {
  attachmentId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  schemaVersion: 1,
  pageUrl: "https://legacy.example/",
  pageTitle: "Legacy",
  capturedAt: "2026-05-08T12:00:00.000Z",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

describe("appendBrowserCaptureFence", () => {
  it("is a no-op when there are zero captures", () => {
    expect(appendBrowserCaptureFence("hello", [])).toBe("hello");
  });

  it("includes the v2 fence opener and valid JSON payloads", () => {
    const out = appendBrowserCaptureFence("user text", [sampleCaptureV2]);
    expect(out).toContain(MCODE_BROWSER_CAPTURE_FENCE_OPEN);
    expect(out).toContain('"schemaVersion":2');
    expect(out).toContain("https://example.com/path");
    expect(out).toContain("visibleTextExcerpt");
    expect(out).toContain("failedRequests");
  });

  it("accepts legacy v1 rows through the shared schema", () => {
    const parsed = AttachedBrowserCaptureSchema().parse(sampleCaptureV1);
    expect(parsed.schemaVersion).toBe(1);
    const out = appendBrowserCaptureFence("x", [sampleCaptureV1]);
    expect(out).toContain('"schemaVersion":1');
  });

  it("clamps oversized v2 headings so the fence still builds", () => {
    const cap = MCODE_BROWSER_CAPTURE_V2_STRING_MAX.headingOutline;
    const row: AttachedBrowserCaptureV2 = {
      ...sampleCaptureV2,
      headingOutline: "H".repeat(cap + 200),
    };
    const out = appendBrowserCaptureFence("user text", [row]);
    expect(out).toContain(MCODE_BROWSER_CAPTURE_FENCE_OPEN);
    const start = out.indexOf(MCODE_BROWSER_CAPTURE_FENCE_OPEN) + MCODE_BROWSER_CAPTURE_FENCE_OPEN.length;
    const end = out.indexOf(MCODE_BROWSER_CAPTURE_FENCE_CLOSE);
    const parsed = JSON.parse(out.slice(start, end).trim()) as AttachedBrowserCaptureV2[];
    expect(parsed[0].headingOutline).toHaveLength(cap);
  });

  it("passes through spillAppDataPath and spillAbsolutePath for agent read_file hints", () => {
    const spillAppData =
      "browser-capture-spill/ws-default/550e8400-e29b-41d4-b716-446655440000.json";
    const spillAbs =
      "C:\\Users\\me\\.mcode-dev\\browser-capture-spill\\ws-default\\550e8400-e29b-41d4-b716-446655440000.json";
    const row: AttachedBrowserCaptureV2 = {
      ...sampleCaptureV2,
      spillAppDataPath: spillAppData,
      spillAbsolutePath: spillAbs,
    };
    const out = appendBrowserCaptureFence("x", [row]);
    const start = out.indexOf(MCODE_BROWSER_CAPTURE_FENCE_OPEN) + MCODE_BROWSER_CAPTURE_FENCE_OPEN.length;
    const end = out.indexOf(MCODE_BROWSER_CAPTURE_FENCE_CLOSE);
    const parsed = JSON.parse(out.slice(start, end).trim()) as AttachedBrowserCaptureV2[];
    expect(parsed[0].spillAppDataPath).toBe(spillAppData);
    expect(parsed[0].spillAbsolutePath).toBe(spillAbs);
  });
});
