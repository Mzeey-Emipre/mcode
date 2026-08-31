import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAnthropicOauthToken } from "../anthropic-credentials.js";

// vi.mock is hoisted to the top of the file, so the mock factory cannot
// reference variables declared with const/let. vi.hoisted runs before the
// hoist and makes the mock available to both the factory and test bodies.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("readAnthropicOauthToken", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-cred-"));
    // Stub both HOME (Linux/macOS) and USERPROFILE (Windows) so homedir()
    // resolves to the temp dir on any platform this test suite runs on.
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("USERPROFILE", tmpHome);
  });

  afterEach(() => {
    NodeFS.rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads plaintext credentials on linux", async () => {
    NodeFS.mkdirSync(NodePath.join(tmpHome, ".claude"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(tmpHome, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat-test",
          expiresAt: 9999999999999,
          refreshToken: "rt-x",
        },
      }),
    );

    const token = await readAnthropicOauthToken("linux");
    expect(token).toEqual({
      accessToken: "sk-ant-oat-test",
      expiresAt: 9999999999999,
    });
  });

  it("returns null when the credentials file is missing", async () => {
    expect(await readAnthropicOauthToken("linux")).toBeNull();
  });

  it("returns null when the file is malformed JSON", async () => {
    NodeFS.mkdirSync(NodePath.join(tmpHome, ".claude"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(tmpHome, ".claude", ".credentials.json"), "{not json");
    expect(await readAnthropicOauthToken("linux")).toBeNull();
  });

  it("invokes `security` on darwin and parses its stdout", async () => {
    const mockJson = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-mac", expiresAt: 1, refreshToken: "r" },
    });

    // Drive execFile synchronously so the promise resolves with the mock output
    execFileMock.mockImplementation(
      (_cmd: unknown, _args: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, mockJson);
      },
    );

    const result = await readAnthropicOauthToken("darwin");
    expect(result).toEqual({ accessToken: "sk-mac", expiresAt: 1 });
  });

  it("returns null when `security` fails on darwin", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(new Error("security: item not found"), "", "");
      },
    );
    const result = await readAnthropicOauthToken("darwin");
    expect(result).toBeNull();
  });

  it("returns null when expiresAt is missing from credentials", async () => {
    NodeFS.mkdirSync(NodePath.join(tmpHome, ".claude"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(tmpHome, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-no-expiry" } }),
    );
    expect(await readAnthropicOauthToken("linux")).toBeNull();
  });

  it("reads plaintext credentials on win32", async () => {
    NodeFS.mkdirSync(NodePath.join(tmpHome, ".claude"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(tmpHome, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-win",
          expiresAt: 42,
          refreshToken: "r",
        },
      }),
    );

    const result = await readAnthropicOauthToken("win32");
    expect(result).toEqual({ accessToken: "sk-win", expiresAt: 42 });
  });

  it("returns null on win32 when the credentials file is missing", async () => {
    expect(await readAnthropicOauthToken("win32")).toBeNull();
  });
});
