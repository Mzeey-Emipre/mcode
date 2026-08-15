import { app } from "electron";
import { readFileSync } from "fs";
import { join } from "path";
import { getMcodeDir } from "@mcode/shared";
import { SettingsSchema as BundledSettingsSchema } from "@mcode/contracts";

/** Use the snapshot-provided schema when V8 has already initialized contracts. */
const SettingsSchema =
  globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/** Release line used to select the updater feed. */
export type ReleaseLine = "stable" | "nightly";

/** Validated settings consumed by the update lifecycle. */
export interface UpdaterSettings {
  /** Stable follows tagged releases; nightly follows the CI prerelease channel. */
  releaseLine: ReleaseLine;
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
  checkInterval: string;
}

/** Reads the validated settings used by one Application Updates instance. */
export type UpdaterSettingsReader = () => UpdaterSettings;

const INTERVAL_MS_MAP: Record<string, number> = {
  "15min": 15 * 60 * 1000,
  "1hour": 60 * 60 * 1000,
  "4hours": 4 * 60 * 60 * 1000,
  "1day": 24 * 60 * 60 * 1000,
  never: Infinity,
};

/** Returns true when the supplied application version is a nightly build. */
function isNightlyBuild(applicationVersion: string): boolean {
  return applicationVersion.includes("-nightly.");
}

/** Read validated updater settings and apply the existing packaged defaults. */
export function loadUpdaterSettings(
  applicationVersion = app.getVersion(),
): UpdaterSettings {
  const defaults: UpdaterSettings = {
    releaseLine: isNightlyBuild(applicationVersion) ? "nightly" : "stable",
    autoDownload: true,
    autoInstallOnQuit: true,
    checkInterval: "4hours",
  };
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const result = SettingsSchema().safeParse(parsed);
    if (result.success) {
      // The schema defaults an absent channel to stable. Preserve nightly
      // builds' implicit nightly selection when the user has not set it.
      const explicitChannel = parsed?.updates?.channel as string | undefined;
      const releaseLine = explicitChannel
        ? (result.data.updates.channel as ReleaseLine)
        : defaults.releaseLine;

      return {
        releaseLine,
        autoDownload:
          result.data.updates?.autoDownload ?? defaults.autoDownload,
        autoInstallOnQuit:
          result.data.updates?.autoInstallOnQuit ?? defaults.autoInstallOnQuit,
        checkInterval:
          result.data.updates?.checkInterval ?? defaults.checkInterval,
      };
    }
    console.warn(
      "[auto-updater] settings.json failed validation, using defaults",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[auto-updater] settings.json could not be loaded, using defaults: ${message}`,
      );
    }
  }
  return defaults;
}

/** Convert a persisted check interval to milliseconds. */
export function intervalToMs(interval: string): number {
  return INTERVAL_MS_MAP[interval] ?? 4 * 60 * 60 * 1000;
}
