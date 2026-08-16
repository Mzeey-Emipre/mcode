/**
 * Resolves the user's current environment from a login shell (Unix) or the
 * Windows registry machine + user hives, for passing to child processes.
 */

import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { flattenProcessEnv, parseNewlineDelimitedEnv, parseNullDelimitedEnv } from "./shell-env-utils.js";

const execFileAsync = promisify(execFile);

const RESOLVE_TIMEOUT_MS = 5000;
const MAX_ENV_BUFFER_BYTES = 32 * 1024 * 1024;

// Re-export for call sites that only need helpers without pulling tsyringe metadata.
export { flattenProcessEnv, parseNewlineDelimitedEnv, parseNullDelimitedEnv } from "./shell-env-utils.js";

/**
 * Platform-specific env resolution with a retained last-good fallback.
 */
@injectable()
export class ShellEnvResolver {
  private lastSuccess: Record<string, string> | null = null;
  private readonly bootEnv: Record<string, string>;

  constructor() {
    this.bootEnv = flattenProcessEnv(process.env);
  }

  /**
   * Best-known resolved overlay (fresh shell/registry or boot snapshot).
   * Safe to merge synchronously without blocking on a shell spawn.
   */
  peekResolvedOverlay(): Record<string, string> {
    return this.lastSuccess ?? { ...this.bootEnv };
  }

  private unixLoginShell(): string {
    const fromEnv = process.env.SHELL?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    try {
      const fromOs = userInfo().shell?.trim();
      if (fromOs) {
        return fromOs;
      }
    } catch {
      /* ignored: unmapped uid on some systems */
    }
    return "/bin/sh";
  }

  /**
   * Refreshes overlay asynchronously (no `execFileSync`) and updates
   * {@link peekResolvedOverlay} on success.
   */
  async resolveFreshAsync(): Promise<Record<string, string>> {
    try {
      const resolved =
        process.platform === "win32"
          ? await this.resolveWindowsAsync()
          : await this.resolveUnixAsync();
      if (Object.keys(resolved).length === 0) {
        throw new Error("resolved env empty");
      }
      this.lastSuccess = resolved;
      return resolved;
    } catch (err) {
      logger.warn("ShellEnvResolver: fresh resolution failed; using fallback env", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.lastSuccess ?? { ...this.bootEnv };
    }
  }

  private async resolveUnixAsync(): Promise<Record<string, string>> {
    const shell = this.unixLoginShell();
    try {
      const { stdout: buf } = await execFileAsync(shell, ["-ilc", "env -0"], {
        encoding: "buffer",
        timeout: RESOLVE_TIMEOUT_MS,
        maxBuffer: MAX_ENV_BUFFER_BYTES,
        windowsHide: true,
      });
      const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as string, "utf8");
      if (buffer.includes(0)) {
        return parseNullDelimitedEnv(buffer);
      }
    } catch {
      /* macOS/BSD often lack env -0 */
    }
    const { stdout: text } = await execFileAsync(shell, ["-ilc", "env"], {
      encoding: "utf8",
      timeout: RESOLVE_TIMEOUT_MS,
      maxBuffer: MAX_ENV_BUFFER_BYTES,
      windowsHide: true,
    });
    return parseNewlineDelimitedEnv(text as string);
  }

  private async resolveWindowsAsync(): Promise<Record<string, string>> {
    // Each element must be a complete PowerShell statement because they are
    // joined with "; ". Splitting if/else across elements would orphan the
    // "else" keyword after the semicolon statement-terminator.
    const script = [
      "$m = [Environment]::GetEnvironmentVariables('Machine')",
      "$u = [Environment]::GetEnvironmentVariables('User')",
      "$r = @{}",
      "foreach ($k in $m.Keys) { $r[$k] = $m[$k] }",
      "foreach ($k in $u.Keys) { if ($k -eq 'Path') { $r[$k] = $m[$k] + ';' + $u[$k] } else { $r[$k] = $u[$k] } }",
      "$sb = New-Object System.Text.StringBuilder",
      "foreach ($k in $r.Keys) { [void]$sb.Append($k).Append('=').Append($r[$k]).Append([char]0) }",
      "$bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())",
      "[Console]::Out.Write([Convert]::ToBase64String($bytes))",
    ].join("; ");

    const { stdout: out } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        timeout: RESOLVE_TIMEOUT_MS,
        maxBuffer: MAX_ENV_BUFFER_BYTES,
        windowsHide: true,
      },
    );
    const buf = Buffer.from((out as string).trim(), "base64");
    return parseNullDelimitedEnv(buf);
  }
}
