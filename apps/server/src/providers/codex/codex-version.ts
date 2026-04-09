import { spawnSync } from "child_process";

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
  const result = spawnSync(cliPath, ["--version"], {
    shell: true,
    timeout: 5000,
    encoding: "utf8",
  });

  const notFoundError =
    cliPath === "codex"
      ? "Codex CLI not found. Install it with: npm install -g @openai/codex\n\nOr set a custom path in Settings > Provider > Codex CLI path."
      : `Codex CLI not found at "${cliPath}". Check the path in Settings > Provider > Codex CLI path.`;

  if (result.error != null || result.status !== 0) {
    return { ok: false, error: notFoundError };
  }

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const match = output.match(/(\d+\.\d+\.\d+)/);

  if (match == null) {
    return { ok: false, error: notFoundError };
  }

  return { ok: true, version: match[1] };
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
