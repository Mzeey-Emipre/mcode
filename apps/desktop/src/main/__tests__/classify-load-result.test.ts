import { describe, it, expect } from "vitest";
import { classifyLoadResult, crashError } from "../preview/classify-load-result.js";

describe("classifyLoadResult", () => {
  it("returns 'ok' for a clean main-frame load (no error code, no http error)", () => {
    expect(classifyLoadResult(true, 0, "", 200, "https://x.test")).toBe("ok");
  });

  it("classifies main-frame HTTP 404 as http with status and 'Page not found'", () => {
    const r = classifyLoadResult(true, 0, "", 404, "https://x.test/missing");
    expect(r).toEqual({ kind: "http", status: 404, message: "Page not found" });
  });

  it("classifies a generic 4xx as http with a neutral message", () => {
    const r = classifyLoadResult(true, 0, "", 403, "https://x.test/forbidden");
    expect(r).toEqual({ kind: "http", status: 403, message: "The site returned an error" });
  });

  it("classifies main-frame HTTP 5xx as http with 'The site had an error'", () => {
    const r = classifyLoadResult(true, 0, "", 503, "https://x.test");
    expect(r).toEqual({ kind: "http", status: 503, message: "The site had an error" });
  });

  it("returns 'ok' for ERR_ABORTED (-3): redirects and user cancels are not failures", () => {
    expect(classifyLoadResult(true, -3, "ERR_ABORTED", 0, "https://x.test")).toBe("ok");
  });

  it("returns 'ok' for any sub-frame failure so the whole page is not blanked", () => {
    expect(classifyLoadResult(false, -105, "ERR_NAME_NOT_RESOLVED", 0, "https://ad.test")).toBe(
      "ok",
    );
    // Even a sub-frame HTTP error must not blank the page.
    expect(classifyLoadResult(false, 0, "", 500, "https://ad.test")).toBe("ok");
  });

  it("classifies ERR_FILE_NOT_FOUND (-6) as file-not-found and carries the code", () => {
    const r = classifyLoadResult(true, -6, "ERR_FILE_NOT_FOUND", 0, "file:///gone.html");
    expect(r).toEqual({
      kind: "file-not-found",
      code: "ERR_FILE_NOT_FOUND",
      message: "File no longer exists",
    });
  });

  it("classifies DNS / offline errors as network and surfaces the net-error code", () => {
    const r = classifyLoadResult(true, -105, "ERR_NAME_NOT_RESOLVED", 0, "https://nope.test");
    expect(r).toEqual({
      kind: "network",
      code: "ERR_NAME_NOT_RESOLVED",
      message: "Can't reach this site",
    });
  });

  it("classifies an unknown negative net error on the main frame as network", () => {
    const r = classifyLoadResult(true, -2, "ERR_FAILED", 0, "https://x.test");
    expect(r).toEqual({ kind: "network", code: "ERR_FAILED", message: "Can't reach this site" });
  });

  it("prefers the HTTP status when both an http error and a benign code are present", () => {
    const r = classifyLoadResult(true, 0, "", 404, "https://x.test");
    expect(r).toEqual({ kind: "http", status: 404, message: "Page not found" });
  });
});

describe("crashError", () => {
  it("builds a crash error with 'This page crashed'", () => {
    expect(crashError()).toEqual({ kind: "crash", message: "This page crashed" });
  });
});
