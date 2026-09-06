import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assertRuntimeDirectorySafe } from "../agent/runtime-contract.mjs";

/** Resolve the local Electron executable for the workspace. */
export function resolveElectronBinary(rootDir) {
  try {
    const desktopRequire = NodeModule.createRequire(NodePath.resolve(rootDir, "apps", "desktop", "package.json"));
    const electronPath = desktopRequire("electron");
    return NodeFS.existsSync(electronPath) ? electronPath : null;
  } catch {
    return null;
  }
}

/** Resolve the Electron ABI better-sqlite3 binding. */
export function resolveElectronBinding(rootDir) {
  const serverRequire = NodeModule.createRequire(NodePath.resolve(rootDir, "apps", "server", "package.json"));
  const packagePath = serverRequire.resolve("better-sqlite3/package.json");
  const bindingPath = NodePath.resolve(NodePath.dirname(packagePath), "build", "Release", "better_sqlite3.electron.node");
  if (!NodeFS.existsSync(bindingPath)) {
    throw new Error(`Workspace Electron better-sqlite3 binding not found: ${bindingPath}`);
  }
  return bindingPath;
}

/** Ensure the runtime directories required by a launcher exist. */
export function prepareRuntimeDirectories(paths) {
  for (const directory of [
    paths.dbDir,
    paths.logsDir,
    paths.pidsDir,
    paths.playwrightScratchDir,
    paths.electronDir,
  ]) {
    assertRuntimeDirectorySafe(directory, "runtime directory", true);
    NodeFS.mkdirSync(directory, { recursive: true });
  }
}

/** Poll an HTTP endpoint until it returns a successful response. */
export async function waitForHttpOk(
  url,
  label,
  timeoutMs = 30_000,
  { fetchImpl = globalThis.fetch, intervalMs = 300, probeTimeoutMs = 1_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - Date.now());
    const probeTimer = setTimeout(() => controller.abort(), Math.min(probeTimeoutMs, remainingMs));
    try {
      if ((await fetchImpl(url, { signal: controller.signal })).ok) return;
    } catch {
      // Retry until the startup deadline.
    } finally {
      clearTimeout(probeTimer);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  throw new Error(`${label} did not become reachable: ${url}`);
}
