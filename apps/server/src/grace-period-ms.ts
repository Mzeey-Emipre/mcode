import { GRACE_PERIOD_DEFAULT_SECONDS } from "@mcode/contracts";

/**
 * Converts persisted grace-period seconds into milliseconds using mode-aware defaults.
 *
 * When the value is still the schema default, dev uses a shorter wait so local
 * workflows can cycle servers quickly; production keeps the full default unless
 * the user overrides it.
 */
export function resolveGracePeriodMs(
  settingSeconds: number,
  isProduction: boolean,
): number {
  const devDefaultSeconds = 5;

  const seconds =
    settingSeconds !== GRACE_PERIOD_DEFAULT_SECONDS
      ? settingSeconds
      : isProduction
        ? GRACE_PERIOD_DEFAULT_SECONDS
        : devDefaultSeconds;

  return seconds * 1000;
}

/** Returns whether this server process owns its idle lifecycle. */
export function shouldShutdownOnIdle(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.MCODE_AGENT_RUNTIME !== "1";
}
