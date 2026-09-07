import { app } from "electron";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir } from "@mcode/shared";
import { isDesktopDev } from "../../../main/is-desktop-dev.js";
import { resolveServerBinary } from "./binary-resolver.js";

export interface ServerPortBand {
  min: number;
  max: number;
}

export interface SpawnedServerProcess {
  child: NodeChildProcess.ChildProcess;
  stderrStream: NodeFS.WriteStream;
}
export const SERVER_LOG_PATH = NodePath.join(getMcodeDir(), "server-stderr.log");
export const SERVER_ROTATED_LOG_PATH = NodePath.join(getMcodeDir(), "server-stderr.1.log");

export function getServerPortBand(): ServerPortBand {
  if (app.isPackaged) return { min: 19700, max: 19800 };
  return isDesktopDev() ? { min: 19500, max: 19600 } : { min: 19600, max: 19700 };
}

export function spawnServerProcess(port: number, platform: NodeJS.Platform): SpawnedServerProcess {
  const paths = getServerPaths(platform);
  const stderrStream = createServerStderrStream();
  try {
    const child = NodeChildProcess.spawn(paths.bunBinary, [paths.entry], {
      cwd: paths.cwd,
      env: createServerEnvironment(paths, port, platform),
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.unref();
    if (child.stderr) child.stderr.pipe(stderrStream);
    return { child, stderrStream };
  } catch (error) {
    stderrStream.destroy();
    throw error;
  }
}

interface ServerPaths {
  entry: string;
  cwd: string;
  bunBinary: string;
  ptyHostExecutable: string;
}

function getServerPaths(platform: NodeJS.Platform): ServerPaths {
  const desktopRoot = __dirname.endsWith(NodePath.join("dist", "main"))
    ? NodePath.resolve(__dirname, "..", "..")
    : NodePath.resolve(__dirname, "..", "..", "..", "..");
  if (!app.isPackaged) {
    const entry = NodePath.resolve(desktopRoot, "dist", "server", "server.cjs");
    return {
      entry,
      cwd: NodePath.dirname(entry),
      bunBinary: resolveDevelopmentBunBinary(platform),
      ptyHostExecutable: process.execPath,
    };
  }
  const entry = NodePath.resolve(process.resourcesPath, "app.asar.unpacked", "dist", "server", "server.cjs");
  const bunBinary = NodePath.resolve(process.resourcesPath, "bin", platform === "win32" ? "mcode-bun.exe" : "mcode-bun");
  if (!NodeFS.existsSync(bunBinary)) throw new Error(`Packaged Bun runtime not found: ${bunBinary}`);
  const ptyHostExecutable = resolveServerBinary({ isPackaged: true, execPath: process.execPath, resourcesPath: process.resourcesPath, platform });
  if (ptyHostExecutable === process.execPath) throw new Error("Packaged Electron PTY host not found");
  return { entry, cwd: NodePath.dirname(entry), bunBinary, ptyHostExecutable };
}

function resolveDevelopmentBunBinary(platform: NodeJS.Platform): string {
  const configuredBinary = process.env.BUN;
  if (configuredBinary && NodeFS.existsSync(configuredBinary)) {
    return resolveBunRuntimeExecutable(configuredBinary);
  }
  const command = platform === "win32" ? "where.exe" : "which";
  try {
    const output = NodeChildProcess.execFileSync(command, ["bun"], { encoding: "utf8" });
    const executable = output.split(/\r?\n/, 1)[0]?.trim();
    if (executable && NodeFS.existsSync(executable)) {
      return resolveBunRuntimeExecutable(executable);
    }
  } catch {
    // The startup error names the missing runtime instead of starting a different one.
  }
  throw new Error("Bun executable not found. Set BUN to its absolute path or install the pinned workspace runtime.");
}

function resolveBunRuntimeExecutable(candidate: string): string {
  const runtimeExecutable = NodeChildProcess.execFileSync(
    candidate,
    ["-p", "process.execPath"],
    { encoding: "utf8" },
  ).trim();
  if (!NodeFS.existsSync(runtimeExecutable)) {
    throw new Error(`Bun runtime executable not found: ${runtimeExecutable}`);
  }
  return runtimeExecutable;
}

function createServerEnvironment(paths: ServerPaths, port: number, platform: NodeJS.Platform): Record<string, string> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...parentEnvironment } = process.env;
  const env: Record<string, string> = {
    ...(parentEnvironment as Record<string, string>),
    MCODE_PTY_HOST_EXECUTABLE: paths.ptyHostExecutable,
    MCODE_PORT: String(port),
    MCODE_MODE: "desktop",
    MCODE_SINGLE_INSTANCE: "false",
    MCODE_DATA_DIR: getMcodeDir(),
    MCODE_TEMP_DIR: app.getPath("temp"),
    MCODE_VERSION: app.getVersion(),
  };
  setGitEnvironment(env, paths.cwd);
  if (app.isPackaged) {
    env.MCODE_PACKAGED_RESOURCES_ROOT = process.resourcesPath;
    env.MCODE_DRIZZLE_MIGRATIONS_DIR = NodePath.join(paths.cwd, "drizzle");
    env.NODE_PATH = [
      NodePath.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
      process.env.NODE_PATH,
    ].filter(Boolean).join(NodePath.delimiter);
    if (platform === "linux") env.LD_LIBRARY_PATH = [NodePath.dirname(process.execPath), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  return env;
}

function setGitEnvironment(env: Record<string, string>, cwd: string): void {
  for (const [name, args] of [["MCODE_GIT_BRANCH", ["rev-parse", "--abbrev-ref", "HEAD"]], ["MCODE_GIT_TOPLEVEL", ["rev-parse", "--show-toplevel"]]] as const) {
    if (env[name] || !isDesktopDev()) continue;
    try {
      const value = NodeChildProcess.execFileSync("git", args, { encoding: "utf-8", timeout: 3_000, cwd }).trim();
      if (value && value !== "HEAD") env[name] = value;
    } catch {
      // Git metadata is optional outside a checkout.
    }
  }
}

function createServerStderrStream(): NodeFS.WriteStream {
  if (NodeFS.existsSync(SERVER_LOG_PATH)) {
    try {
      if (NodeFS.existsSync(SERVER_ROTATED_LOG_PATH)) NodeFS.unlinkSync(SERVER_ROTATED_LOG_PATH);
      NodeFS.renameSync(SERVER_LOG_PATH, SERVER_ROTATED_LOG_PATH);
    } catch (error) { console.warn("[server-manager] Failed to rotate previous server stderr log", error); }
  }
  return NodeFS.createWriteStream(SERVER_LOG_PATH, { flags: "w" });
}
