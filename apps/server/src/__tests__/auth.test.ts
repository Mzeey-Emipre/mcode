import { describe, it, expect } from "vitest";
import { extractToken, buildAuthCookie } from "../transport/auth";

describe("extractToken", () => {
  it("extracts token from query string", () => {
    const url = "/ws?token=abc123";
    expect(extractToken({ url, headers: {} })).toBe("abc123");
  });

  it("extracts token from Authorization Bearer header", () => {
    expect(
      extractToken({ url: "/", headers: { authorization: "Bearer abc123" } }),
    ).toBe("abc123");
  });

  it("extracts token from mcode-auth cookie", () => {
    expect(
      extractToken({ url: "/", headers: { cookie: "mcode-auth=abc123" } }),
    ).toBe("abc123");
  });

  it("returns null when no token found", () => {
    expect(extractToken({ url: "/", headers: {} })).toBeNull();
  });

  it("prefers query param over cookie", () => {
    expect(
      extractToken({
        url: "/?token=fromQuery",
        headers: { cookie: "mcode-auth=fromCookie" },
      }),
    ).toBe("fromQuery");
  });

  it("prefers query param over Authorization header", () => {
    expect(
      extractToken({
        url: "/?token=fromQuery",
        headers: { authorization: "Bearer fromHeader" },
      }),
    ).toBe("fromQuery");
  });

  it("prefers Authorization header over cookie", () => {
    expect(
      extractToken({
        url: "/",
        headers: {
          authorization: "Bearer fromHeader",
          cookie: "mcode-auth=fromCookie",
        },
      }),
    ).toBe("fromHeader");
  });
});

describe("buildAuthCookie", () => {
  it("returns a correctly formatted Set-Cookie header value", () => {
    expect(buildAuthCookie("abc123")).toBe(
      "mcode-auth=abc123; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000",
    );
  });
});
