import { describe, it, expect } from "vitest";
import { friendlyUpdateError } from "../update-error-message";

describe("friendlyUpdateError", () => {
  it("maps signature/verification failures to a security message", () => {
    expect(friendlyUpdateError("signature verification failed").title).toBe(
      "Update couldn't be verified",
    );
    expect(friendlyUpdateError("sha512 checksum mismatch").title).toBe(
      "Update couldn't be verified",
    );
  });

  it("maps disk-space errors", () => {
    expect(friendlyUpdateError("ENOSPC: no space left on device").title).toBe(
      "Not enough disk space",
    );
  });

  it("maps 403 / forbidden to an access-denied message", () => {
    expect(friendlyUpdateError("HttpError: 403 Forbidden").title).toBe(
      "Update access was denied",
    );
  });

  it("maps 404 / missing latest.yml to a no-package message", () => {
    expect(friendlyUpdateError("HttpError: 404").title).toBe("No update package found");
    expect(friendlyUpdateError("Cannot find latest.yml").title).toBe("No update package found");
  });

  it("maps connectivity errors (incl. download-phase net:: that bypass the main filter)", () => {
    expect(friendlyUpdateError("net::ERR_NAME_NOT_RESOLVED").title).toBe(
      "Couldn't reach the update server",
    );
    expect(friendlyUpdateError("getaddrinfo ENOTFOUND github.com").title).toBe(
      "Couldn't reach the update server",
    );
    expect(friendlyUpdateError("504 Gateway Time-out").title).toBe(
      "Couldn't reach the update server",
    );
  });

  it("falls back to a generic message for unknown errors", () => {
    expect(friendlyUpdateError("Cannot parse update info").title).toBe("Update failed");
    expect(friendlyUpdateError(undefined).title).toBe("Update failed");
    expect(friendlyUpdateError("").title).toBe("Update failed");
  });

  it("always returns a non-empty body with no raw error tokens", () => {
    for (const raw of [
      "net::ERR_NAME_NOT_RESOLVED",
      "HttpError: 404",
      "signature verification failed",
      "boom",
      undefined,
    ]) {
      const { body } = friendlyUpdateError(raw);
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain("net::");
      expect(body).not.toContain("HttpError");
    }
  });
});
