import * as NodeChildProcess from "node:child_process";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * OAuth token plus its expiry timestamp (epoch ms) as written by Claude Code.
 */
export interface AnthropicOauthToken {
  accessToken: string;
  expiresAt: number;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: string;
  };
}

/**
 * Read the Anthropic OAuth access token written by Claude Code.
 * Returns null when the file is missing, unreadable, or unparseable.
 *
 * Per-OS storage:
 *  - darwin: macOS Keychain entry "Claude Code-credentials" (read via the
 *            `security` CLI; no prompts once access has been granted).
 *  - linux:  ~/.claude/.credentials.json (plain JSON, file-mode protected).
 *  - win32:  %USERPROFILE%\.claude\.credentials.json (plain JSON in the
 *            user's profile directory; relies on NTFS ACLs for confidentiality).
 *            Earlier Claude Code releases shipped a DPAPI-encrypted blob; this
 *            reader treats both the same — JSON parse simply fails on a
 *            ciphertext blob and the caller gets null.
 *
 * @param platform - The host platform that stores the credentials.
 */
export async function readAnthropicOauthToken(
  platform: NodeJS.Platform,
): Promise<AnthropicOauthToken | null> {
  try {
    const raw = await readRawCredentials(platform);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as CredentialsFile;
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken || typeof oauth.expiresAt !== "number") return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch {
    return null;
  }
}

/**
 * Read raw credentials string from the platform-specific storage backend.
 * Returns null when credentials are unavailable or an error occurs.
 */
async function readRawCredentials(platform: NodeJS.Platform): Promise<string | null> {
  if (platform === "darwin") {
    // macOS stores credentials in the system Keychain; the `security` CLI
    // can retrieve the password field without prompting when the app has
    // already been granted access.
    try {
      // Use a manual promise so the mock can intercept childProcess.execFile at call time.
      // promisify captures the function reference at wrap time; direct lookup does not.
      const stdout = await new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          (err, out) => {
            if (err) reject(err);
            else resolve(out);
          },
        );
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // Linux and Windows both write a plain JSON file at ~/.claude/.credentials.json.
  // Confidentiality relies on the surrounding directory permissions (Linux:
  // 0700 on .claude/; Windows: NTFS ACLs scoped to the user profile).
  if (platform === "linux" || platform === "win32") {
    try {
      return await NodeFSPromises.readFile(NodePath.join(NodeOS.homedir(), ".claude", ".credentials.json"), "utf8");
    } catch {
      return null;
    }
  }

  return null;
}
