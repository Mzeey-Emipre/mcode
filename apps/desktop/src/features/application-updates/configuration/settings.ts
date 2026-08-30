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
  const defaults = updaterSettingsDefaults(applicationVersion);
  return readPersistedUpdaterSettings(defaults) ?? defaults;
}

/** Return the packaged defaults for the current release line. */
function updaterSettingsDefaults(applicationVersion: string): UpdaterSettings {
  return {
    releaseLine: isNightlyBuild(applicationVersion) ? "nightly" : "stable",
    autoDownload: true,
    autoInstallOnQuit: true,
    checkInterval: "4hours",
  };
}

/** Read valid persisted settings, or return null after the existing diagnostic. */
function readPersistedUpdaterSettings(defaults: UpdaterSettings): UpdaterSettings | null {
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const result = SettingsSchema().safeParse(parsed);
    if (result.success) return mergeUpdaterSettings(parsed, result.data.updates, defaults);
    console.warn("[auto-updater] settings.json failed validation, using defaults");
  } catch (err) {
    logUpdaterSettingsReadFailure(err);
  }
  return null;
}

/** Merge schema defaults with packaged defaults that depend on the application version. */
function mergeUpdaterSettings(
  parsed: unknown,
  updates: NonNullable<ReturnType<typeof SettingsSchema>["_output"]>["updates"],
  defaults: UpdaterSettings,
): UpdaterSettings {
  const explicitChannel = (parsed as { updates?: { channel?: string } }).updates?.channel;
  return {
    releaseLine: explicitChannel ? (updates.channel as ReleaseLine) : defaults.releaseLine,
    autoDownload: updates?.autoDownload ?? defaults.autoDownload,
    autoInstallOnQuit: updates?.autoInstallOnQuit ?? defaults.autoInstallOnQuit,
    checkInterval: updates?.checkInterval ?? defaults.checkInterval,
  };
}

/** Report settings load failures other than a missing optional settings file. */
function logUpdaterSettingsReadFailure(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[auto-updater] settings.json could not be loaded, using defaults: ${message}`);
}

/** Convert a persisted check interval to milliseconds. */
export function intervalToMs(interval: string): number {
  return INTERVAL_MS_MAP[interval] ?? 4 * 60 * 60 * 1000;
}
