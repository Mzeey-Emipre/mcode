/** Resolves the development-only web browser automation opt-in. */
export function resolveWebAutomationFlag(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV !== "development") return false;
  const raw = env.MCODE_WEB_AUTOMATION;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("MCODE_WEB_AUTOMATION must be true or false when set");
}
