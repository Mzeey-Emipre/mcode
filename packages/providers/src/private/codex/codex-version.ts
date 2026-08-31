import * as NodeChildProcess from "node:child_process";

/** Shell metacharacters that must not appear in a CLI path passed to `shell: true`. */
const SHELL_METACHAR_RE = /[;&|`$(){}!<>"'\s\n\r]/;

/** Matches a semver triplet not followed by a fourth dotted segment. */
const SEMVER_RE = /\b(\d+\.\d+\.\d+)(?!\.\d)/;

/**
 * Cached version check results keyed by cliPath. Successes are cached for the
 * app lifetime: the check is a min-version gate, and a CLI upgrade mid-run
 * cannot move below the minimum. Failures are never cached, so a user fixing
 * a broken install recovers on the next send. The cache is warmed off the
 * send path at startup via {@link warmCodexVersionCache}.
 */
const versionCache = new Map<string, { result: ReturnType<typeof checkCodexVersion>; checkedAt: number }>();

/**
 * Checks whether the Codex CLI is reachable and returns its version string.
 *
 * Runs `<cliPath> --version` synchronously with a 5-second timeout.
 * `shell: true` is required on Windows to resolve `.cmd` shims from npm
 * global installs.
 *
 * @param cliPath - Absolute path to the Codex CLI binary, or `"codex"` to
 *   rely on PATH resolution.
 * @returns `{ ok: true, version }` on success, or `{ ok: false, error }` when
 *   the binary cannot be found or no semver string appears in its output.
 */
export function checkCodexVersion(
  cliPath: string,
): { ok: true; version: string } | { ok: false; error: string } {
  if (SHELL_METACHAR_RE.test(cliPath)) {
    return { ok: false, error: `Codex CLI path contains invalid characters: "${cliPath}"` };
  }

  // Cached successes are returned for the app lifetime, avoiding a blocking
  // spawnSync on the event loop on the send path.
  const cached = versionCache.get(cliPath);
  if (cached) {
    return cached.result;
  }

  const result = NodeChildProcess.spawnSync(cliPath, ["--version"], {
    shell: true,
    timeout: 5000,
    encoding: "utf8",
    windowsHide: true,
  });

  const notFoundError =
    cliPath === "codex"
      ? "Codex CLI not found. Install it with: npm install -g @openai/codex\n\nOr set a custom path in Settings > Provider > Codex CLI path."
      : `Codex CLI not found at "${cliPath}". Check the path in Settings > Provider > Codex CLI path.`;

  if (result.error != null) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return {
        ok: false,
        error:
          "Codex CLI timed out (5s). The CLI may be slow to start. Check your network or set a custom path in Settings > Provider > Codex CLI path.",
      };
    }
    return { ok: false, error: notFoundError };
  }

  if (result.status !== 0) {
    return { ok: false, error: notFoundError };
  }

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const match = output.match(SEMVER_RE);

  if (match == null) {
    return { ok: false, error: notFoundError };
  }

  const success = { ok: true as const, version: match[1] };
  versionCache.set(cliPath, { result: success, checkedAt: Date.now() });
  return success;
}

/**
 * Warms the version cache off the send path with a non-blocking `--version`
 * probe. Call at app startup (and on CLI-path settings changes) so the
 * synchronous {@link checkCodexVersion} gate in `sendTurn` is a pure cache
 * hit instead of a blocking spawnSync. No-op when the path is already cached
 * or contains shell metacharacters; failures are not cached (the send-path
 * check surfaces the user-facing error with fresh state).
 */
export function warmCodexVersionCache(cliPath: string): Promise<void> {
  if (SHELL_METACHAR_RE.test(cliPath) || versionCache.has(cliPath)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      cliPath,
      ["--version"],
      { shell: true, timeout: 5000, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err == null) {
          const match = ((stdout ?? "") + (stderr ?? "")).match(SEMVER_RE);
          if (match != null) {
            versionCache.set(cliPath, {
              result: { ok: true, version: match[1] },
              checkedAt: Date.now(),
            });
          }
        }
        resolve();
      },
    );
  });
}

/** Clears the cached version results. Exposed for testing only. */
export function clearVersionCache(): void {
  versionCache.clear();
}

/**
 * Returns `true` when `version` is greater than or equal to `minimum`.
 *
 * Both strings must be valid semver triplets (`major.minor.patch`). Returns
 * `false` for malformed or empty inputs instead of throwing.
 *
 * @param version - The version to test (e.g. `"1.2.3"`).
 * @param minimum - The lowest acceptable version (e.g. `"1.0.0"`).
 */
export function meetsMinVersion(version: string, minimum: string): boolean {
  try {
    const parse = (v: string): [number, number, number] => {
      const parts = v.split(".").map(Number);
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error("invalid semver");
      }
      return parts as [number, number, number];
    };

    const [vMaj, vMin, vPat] = parse(version);
    const [mMaj, mMin, mPat] = parse(minimum);

    if (vMaj !== mMaj) return vMaj > mMaj;
    if (vMin !== mMin) return vMin > mMin;
    return vPat >= mPat;
  } catch {
    return false;
  }
}
