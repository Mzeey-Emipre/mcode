#!/usr/bin/env bun
/** Waits for the started worktree runtime to serve every requested surface. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { probeCdpVersion } from "../../.agents/skills/electorn-live-testing/scripts/start-electron.mjs";
import { isOwnedElectronProcess } from "../../.agents/skills/electorn-live-testing/scripts/stop-electron.mjs";
import { MANAGED_DESKTOP_SESSION_FILE } from "./managed-desktop.mjs";
import { waitForDesktopPage, waitForHttpOk } from "./agent-up.mjs";
import { getRuntimePaths, readPortsFile, resolveRepoRoot } from "./runtime-contract.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Waits for the contract's server, web, and optional managed desktop endpoints. */
export async function agentReady(
  repoRoot = resolveRepoRoot(),
  { timeoutMs = DEFAULT_TIMEOUT_MS, httpOptions, desktopOptions } = {},
) {
  const root = NodePath.resolve(repoRoot);
  assertRuntimeReadPathsSafe(root);
  const contract = readPortsFile(root);
  if (!contract) throw new Error("Runtime contract is missing. Run 'bun run --shell system agent:up' first.");
  if (!samePath(contract.worktreeIdentity, root)) {
    throw new Error("Runtime contract belongs to a different worktree. Run 'bun run --shell system agent:up' again.");
  }

  const desktop = readManagedDesktopSession(root, contract.appUrl);
  await Promise.all([
    waitForHttpOk(contract.healthUrl, "server health", timeoutMs, httpOptions),
    waitForHttpOk(contract.appUrl, "web app", timeoutMs, httpOptions),
    ...(desktop ? [
      waitForCdpVersion(desktop.endpoint, timeoutMs, httpOptions),
      waitForDesktopPage(desktop.endpoint, contract.appUrl, { ...desktopOptions, timeoutMs }),
    ] : []),
  ]);
  return { desktop: Boolean(desktop) };
}

function readManagedDesktopSession(repoRoot, appUrl) {
  const sessionFile = NodePath.join(getRuntimePaths(repoRoot).devDir, MANAGED_DESKTOP_SESSION_FILE);
  if (!NodeFS.existsSync(sessionFile)) return null;
  const stat = NodeFS.lstatSync(sessionFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Managed desktop session record is invalid. Run 'bun run --shell system agent:down' first.");
  }
  let session;
  try {
    session = JSON.parse(NodeFS.readFileSync(sessionFile, "utf8"));
  } catch {
    throw new Error("Managed desktop session record is invalid. Run 'bun run --shell system agent:down' first.");
  }
  if (!isManagedDesktopSession(session, repoRoot, appUrl) || !isOwnedElectronProcess(session, repoRoot)) {
    throw new Error("Managed desktop session belongs to a different worktree or app. Run 'bun run --shell system agent:down' first.");
  }
  return session;
}

function isManagedDesktopSession(session, repoRoot, appUrl) {
  return hasManagedDesktopIdentity(session, repoRoot, appUrl)
    && hasManagedDesktopProcess(session)
    && hasManagedDesktopEndpoint(session);
}

function hasManagedDesktopIdentity(session, repoRoot, appUrl) {
  return Boolean(session && typeof session === "object" && session.status === "running")
    && samePath(session.repoRoot, repoRoot)
    && session.appUrlPrefix === appUrl;
}

function hasManagedDesktopProcess(session) {
  return Number.isSafeInteger(session.pid) && session.pid > 0 && typeof session.executablePath === "string";
}

function hasManagedDesktopEndpoint(session) {
  if (!Number.isInteger(session.debugPort) || session.debugPort <= 0 || session.debugPort > 65_535) return false;
  return session.endpoint === `http://127.0.0.1:${session.debugPort}`;
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    const normalizedLeft = NodeFS.realpathSync.native(left);
    const normalizedRight = NodeFS.realpathSync.native(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}

async function waitForCdpVersion(endpoint, timeoutMs, httpOptions) {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = httpOptions?.intervalMs ?? 300;
  const probeTimeoutMs = httpOptions?.probeTimeoutMs ?? 1_000;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    if (await probeCdpVersion(endpoint, { timeoutMs: Math.min(probeTimeoutMs, remainingMs) })) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  throw new Error("desktop CDP did not become reachable before the readiness deadline");
}

function assertRuntimeReadPathsSafe(repoRoot) {
  const { devDir, portsFile } = getRuntimePaths(repoRoot);
  assertNotLinkedPath(devDir, "runtime directory", true);
  assertNotLinkedPath(portsFile, "runtime contract", true);
}

function assertNotLinkedPath(path, label, allowMissing) {
  try {
    const stats = NodeFS.lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error(`The ${label} must not be a link.`);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const result = await agentReady();
    process.stdout.write(`Agent runtime is ready${result.desktop ? " with desktop" : ""}.\n`);
  } catch (error) {
    process.stderr.write(`Agent runtime is not ready: ${error.message}\n`);
    process.exitCode = 1;
  }
}
