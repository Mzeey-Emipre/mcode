/**
 * Pure helpers for serializing and parsing environment maps used by
 * {@link ShellEnvResolver} and child-process spawns (no DI).
 */

/**
 * Flattens `process.env` to a string-only record (drops undefined entries).
 */
export function flattenProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Parses newline-delimited `env` output (KEY=value per line).
 * Values containing literal newlines will be split incorrectly;
 * prefer {@link parseNullDelimitedEnv} when `env -0` is available.
 */
export function parseNewlineDelimitedEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Parses `env -0` style NUL-delimited KEY=value chunks.
 */
export function parseNullDelimitedEnv(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (buf.length === 0) {
    return out;
  }
  const raw = buf.toString("utf8");
  const parts = raw.split("\0");
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    out[key] = value;
  }
  return out;
}
