import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/** Shell metacharacters that must not appear in a CLI path passed to `shell: true`. */
const SHELL_METACHAR_RE = /[;&|`$(){}!<>"'\s\n\r]/;

/** Resolved CLI binary plus its version string from `opencode --version`. */
export interface OpenCodeCliProbe {
  binaryPath: string;
  version: string;
}

/**
 * Detect the `opencode` CLI without applying caller policy.
 * `shell: true` is required on Windows to resolve the `.cmd` shim from npm
 * global installs; paths with shell metacharacters are rejected first.
 */
export async function probeOpenCodeCli(cliPath: string, platform: string): Promise<OpenCodeCliProbe> {
  const binary = cliPath.trim() || "opencode";
  if (SHELL_METACHAR_RE.test(binary) && binary !== "opencode") {
    throw new Error(`OpenCode CLI path contains invalid characters: "${binary}"`);
  }
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
      shell: platform === "win32",
    });
    return { binaryPath: binary, version: stdout.trim().slice(0, 128) };
  } catch (error) {
    throw new Error(`OpenCode CLI not found at ${binary}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
