import { app } from "electron";
import { execSync, spawn, type ChildProcess } from "child_process";
import { createRequire } from "module";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  type WriteStream,
} from "fs";
import { dirname, join, resolve } from "path";
import { getMcodeDir } from "@mcode/shared";
import {
  SettingsSchema as BundledSettingsSchema,
  SERVER_HEAP_DEFAULT_MB,
  SERVER_HEAP_MAX_MB,
  SERVER_HEAP_MIN_MB,
} from "@mcode/contracts";
import { isDesktopDev } from "../../../main/is-desktop-dev.js";
import { resolveServerBinary } from "./binary-resolver.js";

/** Use snapshot-provided schema when available. */
const SettingsSchema =
  globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/** Current desktop-mode server port band. */
export interface ServerPortBand {
  min: number;
  max: number;
}

/** Spawned server process and its optional packaged stderr stream. */
export interface SpawnedServerProcess {
  child: ChildProcess;
  stderrStream: WriteStream | undefined;
}

/** Server stderr log file path. */
export const SERVER_LOG_PATH = join(getMcodeDir(), "server-stderr.log");

/** Previous server stderr log file path. */
export const SERVER_ROTATED_LOG_PATH = join(
  getMcodeDir(),
  "server-stderr.1.log",
);

/** Return the port band for the active desktop mode. */
export function getServerPortBand(): ServerPortBand {
  if (app.isPackaged) return { min: 19700, max: 19800 };
  return isDesktopDev()
    ? { min: 19500, max: 19600 }
    : { min: 19600, max: 19700 };
}

/** Spawn the detached Mcode server child for the assigned port. */
export function spawnServerProcess(
  port: number,
  platform: NodeJS.Platform,
): SpawnedServerProcess {
  const paths = getServerPaths();
  const heapMb = readServerHeapMb();
  console.log(
    `[server-manager] Server configured: --max-old-space-size=${heapMb}`,
  );
  const stderrStream = createServerStderrStream();
  try {
    const child = spawnServerBinary(paths, port, heapMb, stderrStream, platform);
    child.unref();
    pipeServerStderr(child, stderrStream);
    return { child, stderrStream };
  } catch (error) {
    stderrStream?.destroy();
    throw error;
  }
}

/** Resolve the server entry point and the approved native SQLite binding. */
function getServerPaths(): ServerPaths {
  return app.isPackaged
    ? getPackagedServerPaths()
    : getDevelopmentServerPaths();
}

/** Server paths that the detached child requires. */
interface ServerPaths {
  entry: string;
  cwd: string;
  nativeBindingPath: string;
}

/** Resolve paths from the packaged app's unpacked resources. */
function getPackagedServerPaths(): ServerPaths {
  const unpackedRoot = resolve(process.resourcesPath, "app.asar.unpacked");
  const entry = resolve(unpackedRoot, "dist", "server", "server.cjs");
  const nativeBindingPath = resolve(
    unpackedRoot,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (!existsSync(nativeBindingPath)) {
    throw new Error(
      `Packaged better-sqlite3 binding not found: ${nativeBindingPath}`,
    );
  }
  return { entry, cwd: dirname(entry), nativeBindingPath };
}

/** Resolve paths from a source checkout or the desktop build output. */
function getDevelopmentServerPaths(): ServerPaths {
  const desktopRoot = __dirname.endsWith(join("dist", "main"))
    ? resolve(__dirname, "..", "..")
    : resolve(__dirname, "..", "..", "..", "..");
  const entry = resolve(desktopRoot, "dist", "server", "server.cjs");
  const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
  const betterSqliteDir = dirname(
    desktopRequire.resolve("better-sqlite3/package.json"),
  );
  const nativeBindingPath = resolve(
    betterSqliteDir,
    "build",
    "Release",
    "better_sqlite3.electron.node",
  );
  if (!existsSync(nativeBindingPath)) {
    throw new Error(
      `Workspace Electron better-sqlite3 binding not found: ${nativeBindingPath}`,
    );
  }
  return { entry, cwd: dirname(entry), nativeBindingPath };
}

/** Return the V8 old-space limit for the server process. */
function readServerHeapMb(): number {
  const configuredHeap = readConfiguredHeapMb();
  if (configuredHeap !== null) return configuredHeap;
  return readSettingsHeapMb();
}

/** Read the explicit heap limit from the process environment. */
function readConfiguredHeapMb(): number | null {
  const value = process.env.MCODE_SERVER_HEAP_MB;
  if (value === undefined) return null;
  const heapMb = Number(value);
  if (isAllowedHeapMb(heapMb)) return heapMb;
  console.warn(
    `[server-manager] MCODE_SERVER_HEAP_MB="${value}" is invalid ` +
      `(parsed: ${heapMb}, allowed: ${SERVER_HEAP_MIN_MB}-${SERVER_HEAP_MAX_MB} integer). ` +
      "Falling through to settings.json.",
  );
  return null;
}

/** Return whether a heap size is a supported integer limit. */
function isAllowedHeapMb(heapMb: number): boolean {
  return (
    Number.isInteger(heapMb) &&
    heapMb >= SERVER_HEAP_MIN_MB &&
    heapMb <= SERVER_HEAP_MAX_MB
  );
}

/** Read the heap limit from the settings file or use the default. */
function readSettingsHeapMb(): number {
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const settings = SettingsSchema().safeParse(JSON.parse(raw));
    if (settings.success) return settings.data.server.memory.heapMb;
    console.warn(
      "[server-manager] settings.json parse failed, using default heap",
    );
  } catch {
    // A missing or unreadable settings file uses the contract default.
  }
  return SERVER_HEAP_DEFAULT_MB;
}

/** Create the detached child with its Electron and Mcode runtime environment. */
function spawnServerBinary(
  paths: ServerPaths,
  port: number,
  heapMb: number,
  stderrStream: NodeFS.WriteStream | undefined,
  platform: NodeJS.Platform,
): NodeChildProcess.ChildProcess {
  const env = createServerEnvironment(paths, port, platform);
  const binary = resolveServerBinary({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    platform,
  });
  return NodeChildProcess.spawn(binary, createServerArgs(paths.entry, heapMb), {
    cwd: paths.cwd,
    env,
    detached: true,
    stdio: isDesktopDev()
      ? "inherit"
      : ["ignore", "ignore", stderrStream ? "pipe" : "ignore"],
  });
}

/** Build the complete environment for a detached server process. */
function createServerEnvironment(
  paths: ServerPaths,
  port: number,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELECTRON_RUN_AS_NODE: "1",
    MCODE_PORT: String(port),
    MCODE_MODE: "desktop",
    MCODE_SINGLE_INSTANCE: "false",
    MCODE_DATA_DIR: getMcodeDir(),
    MCODE_TEMP_DIR: app.getPath("temp"),
    MCODE_VERSION: app.getVersion(),
    BETTER_SQLITE3_BINDING: paths.nativeBindingPath,
  };
  setGitEnvironment(env, paths.cwd);
  setPackagedEnvironment(env, platform);
  return env;
}

/** Preserve supplied Git metadata or discover it for development worktrees. */
function setGitEnvironment(env: Record<string, string>, cwd: string): void {
  setGitEnvironmentValue(
    env,
    "MCODE_GIT_BRANCH",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
  );
  setGitEnvironmentValue(
    env,
    "MCODE_GIT_TOPLEVEL",
    ["rev-parse", "--show-toplevel"],
    cwd,
  );
}

/** Set one Git environment variable when a development checkout can provide it. */
function setGitEnvironmentValue(
  env: Record<string, string>,
  name: "MCODE_GIT_BRANCH" | "MCODE_GIT_TOPLEVEL",
  args: string[],
  cwd: string,
): void {
  const configuredValue = process.env[name];
  if (configuredValue) {
    env[name] = configuredValue;
    return;
  }
  if (!isDesktopDev()) return;
  try {
    const discoveredValue = execSync(`git ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 3_000,
      cwd,
    }).trim();
    if (discoveredValue && discoveredValue !== "HEAD")
      env[name] = discoveredValue;
  } catch {
    // Git data is optional when Electron does not run from a checkout.
  }
}

/** Add packaged-resource and Linux dynamic-library environment values. */
function setPackagedEnvironment(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): void {
  if (!app.isPackaged) return;
  env.MCODE_PACKAGED_RESOURCES_ROOT = process.resourcesPath;
  setPackagedLinuxLibraryPath(env, platform);
}

/** Point packaged Linux children at Electron's shared libraries. */
function setPackagedLinuxLibraryPath(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): void {
  if (platform !== "linux") return;
  env.LD_LIBRARY_PATH = [NodePath.dirname(process.execPath), process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
}

/** Build V8 flags and the bundled server entry argument. */
function createServerArgs(entry: string, heapMb: number): string[] {
  const flags = [
    `--max-old-space-size=${heapMb}`,
    "--max-semi-space-size=2",
    "--expose-gc",
  ];
  if (app.isPackaged) {
    flags.push(
      "--report-on-fatalerror",
      `--report-directory=${getMcodeDir()}`,
      "--heapsnapshot-near-heap-limit=1",
    );
  }
  return [...flags, entry];
}

/** Rotate stderr logs and open the current packaged-server log stream. */
function createServerStderrStream(): WriteStream | undefined {
  if (isDesktopDev()) return undefined;
  rotateServerLog();
  return createWriteStream(SERVER_LOG_PATH, { flags: "w" });
}

/** Retain one previous packaged-server stderr log for crash diagnosis. */
function rotateServerLog(): void {
  if (!existsSync(SERVER_LOG_PATH)) return;
  try {
    if (existsSync(SERVER_ROTATED_LOG_PATH))
      unlinkSync(SERVER_ROTATED_LOG_PATH);
    renameSync(SERVER_LOG_PATH, SERVER_ROTATED_LOG_PATH);
  } catch (error) {
    console.warn(
      "[server-manager] Failed to rotate previous server stderr log",
      error,
    );
  }
}

/** Stream packaged server stderr into the bounded log file. */
function pipeServerStderr(
  child: ChildProcess,
  stderrStream: WriteStream | undefined,
): void {
  if (stderrStream && child.stderr) child.stderr.pipe(stderrStream);
}
