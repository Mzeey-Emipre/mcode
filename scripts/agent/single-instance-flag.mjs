/**
 * Resolves script-level MCODE_SINGLE_INSTANCE overrides for dev runtimes.
 *
 * @param {string | undefined} raw
 * @returns {boolean}
 */
export function resolveDevSingleInstanceFlag(raw) {
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    throw new Error("MCODE_SINGLE_INSTANCE must be true or false when set");
  }
  return true;
}
