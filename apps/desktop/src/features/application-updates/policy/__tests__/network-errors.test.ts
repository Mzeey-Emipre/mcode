import { describe, expect, it } from "vitest";
import { isTransientNetworkError } from "../network-errors";

describe("isTransientNetworkError", () => {
  it.each([
    "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_INTERNET_DISCONNECTED",
    "net::ERR_CONNECTION_RESET",
    "net::ERR_TIMED_OUT",
    "net::ERR_PROXY_CONNECTION_FAILED",
  ])("classifies Chromium connectivity error %s as transient", (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });

  it.each([
    ["ENOTFOUND", "getaddrinfo ENOTFOUND github.com"],
    ["ECONNREFUSED", "connect ECONNREFUSED"],
    ["ETIMEDOUT", "read ETIMEDOUT"],
  ])("classifies Node code %s as transient", (code, message) => {
    expect(
      isTransientNetworkError(Object.assign(new Error(message), { code })),
    ).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "classifies HTTP status %s as transient",
    (statusCode) => {
      expect(
        isTransientNetworkError(
          Object.assign(new Error("request failed"), { statusCode }),
        ),
      ).toBe(true);
    },
  );

  it.each(["504 Gateway Time-out", "503 Service Unavailable", "502 Bad Gateway"])(
    "classifies gateway response %s as transient",
    (message) => {
      expect(isTransientNetworkError(new Error(message))).toBe(true);
    },
  );

  it.each([
    new Error("HttpError: 404"),
    new Error("signature verification failed"),
    new Error("Cannot find latest.yml"),
    Object.assign(new Error("forbidden"), { statusCode: 403 }),
    Object.assign(new Error("not found"), { statusCode: 404 }),
    undefined,
    null,
  ])("does not classify non-transient failure %# as transient", (error) => {
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("classifies a non-Error connectivity message by token", () => {
    expect(isTransientNetworkError("net::ERR_NAME_NOT_RESOLVED")).toBe(true);
  });
});
