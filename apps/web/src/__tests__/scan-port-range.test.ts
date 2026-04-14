import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scanPortRange } from "../transport/scan-port-range";

beforeEach(() => {
  // Clear localStorage before each test
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("scanPortRange", () => {
  it("returns a WebSocket URL using the fresh token from the health response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:19400/health") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: "ok", authToken: "fresh-token-abc" }),
          });
        }
        return Promise.resolve({ ok: false });
      }),
    );

    const result = await scanPortRange(19400, 19402, "stale-token");

    expect(result).toBe("ws://localhost:19400?token=fresh-token-abc");
  });

  it("persists the fresh token to localStorage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:19400/health") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: "ok", authToken: "fresh-token-abc" }),
          });
        }
        return Promise.resolve({ ok: false });
      }),
    );

    await scanPortRange(19400, 19402, "stale-token");

    expect(localStorage.getItem("mcode-auth-token")).toBe("fresh-token-abc");
  });

  it("falls back to the saved token when the health response has no authToken", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:19400/health") {
          return Promise.resolve({
            ok: true,
            // Health response with no authToken field
            json: () => Promise.resolve({ status: "ok" }),
          });
        }
        return Promise.resolve({ ok: false });
      }),
    );

    const result = await scanPortRange(19400, 19402, "saved-token");

    expect(result).toBe("ws://localhost:19400?token=saved-token");
  });

  it("falls back to the saved token when the health response body cannot be parsed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:19400/health") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.reject(new Error("invalid JSON")),
          });
        }
        return Promise.resolve({ ok: false });
      }),
    );

    const result = await scanPortRange(19400, 19402, "saved-token");

    expect(result).toBe("ws://localhost:19400?token=saved-token");
  });

  it("returns null when no port in range responds healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false }),
    );

    const result = await scanPortRange(19400, 19402, "any-token");

    expect(result).toBeNull();
  });

  it("uses the first healthy port when multiple ports respond", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        // Only port 19401 is healthy
        if (url === "http://localhost:19401/health") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ authToken: "token-from-19401" }),
          });
        }
        return Promise.resolve({ ok: false });
      }),
    );

    const result = await scanPortRange(19400, 19403, "old-token");

    expect(result).toBe("ws://localhost:19401?token=token-from-19401");
  });

  it("sends the saved token in the Authorization header when probing", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === "http://localhost:19400/health") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ authToken: "new-token" }),
        });
      }
      return Promise.resolve({ ok: false });
    });
    vi.stubGlobal("fetch", mockFetch);

    await scanPortRange(19400, 19402, "saved-token");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:19400/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer saved-token" },
      }),
    );
  });
});
