#!/usr/bin/env bun
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  assertInsideDevDir,
  getRuntimePaths,
  readPortsFile,
  resolveRepoRoot,
} from "../../../../scripts/agent/runtime-contract.mjs";

const HEALTH_TIMEOUT_MS = 15_000;
const WORKFLOW_TIMEOUT_MS = 45_000;
const FRESHNESS_TOLERANCE_MS = 2_000;
const ELECTRON_SESSION_FILE = "electron-thread-lifecycle.json";
const EVIDENCE_DIRECTORY = ".dev/verification/thread-lifecycle";
const DESKTOP_BUILD_COMMAND = "bun run --cwd apps/desktop build";
const DESKTOP_WORKFLOW_SOURCE_DIRECTORIES = [
  ["apps", "desktop", "src"],
  ["apps", "web", "src"],
];
const RUN_ID_TEXT = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_ID_PATTERN = new RegExp(`^${RUN_ID_TEXT}$`, "i");
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const OWNED_RECEIPT_PATTERN = new RegExp(`^${RUN_ID_TEXT}-(?:receipt|failure)\\.json$|^${RUN_ID_TEXT}-(?:completed|failure)\\.png$`, "i");
const OWNED_LOG_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:thread-lifecycle-server|thread-lifecycle-web|lint)\.log$/;
const FOCUSED_SERVER_TESTS = [
  "src/features/projects/worktrees/__tests__/sandbox-worktree-cleanup-policy.test.ts",
  "src/features/thread-control/cleanup/__tests__/cleanup-integration.test.ts",
  "src/features/thread-control/cleanup/__tests__/cleanup-worker.test.ts",
  "src/features/thread-control/cleanup/__tests__/completed-thread-cleanup-git.integration.test.ts",
  "src/features/thread-control/lifecycle/__tests__/thread-completion-service.test.ts",
  "src/features/thread-control/lifecycle/__tests__/thread-deletion-teardown-service.test.ts",
  "src/features/thread-control/lifecycle/__tests__/thread-service.test.ts",
];
const FOCUSED_WEB_TESTS = [
  "src/features/projects/__tests__/ProjectTree.test.tsx",
  "src/features/projects/state/__tests__/workspaceStore.completion.test.ts",
];

const HELP = `Verify Mcode thread lifecycle

Usage:
  bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs thread-lifecycle <command> [options]

Commands:
  health
      Validate the current worktree runtime and its disposable fixture repository.
  check
      Run focused completion, cleanup, worktree-safety, and Project Tree tests.
  proof --confirm-cleanup
      Create disposable state, complete a worktree thread through Electron, capture proof, and remove the generated state.
  inspect
      Summarize the active run and captured evidence without exposing runtime credentials.
  cleanup --confirm-cleanup
      Remove only state and evidence created by this verifier.

The live proof confirms completion and its scheduled deletion. Retention expiry has a one-day minimum, so focused integration tests prove the later cleanup-worker removal.`;

async function main() {
  const command = safeText(process.argv[2] ?? "help");
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }

    const repoRoot = resolveRepoRoot();
    const output = await execute(parsed, repoRoot);
    process.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, ...output }, null, 2)}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      command,
      failure: safeError(error),
    }, null, 2)}\n`);
  }
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...options] = argv;
  validateCommand(command);
  return requiresCleanupConfirmation(command)
    ? parseConfirmedCommand(command, options)
    : parseOptionlessCommand(command, options);
}

function validateCommand(command) {
  if (["health", "check", "proof", "inspect", "cleanup"].includes(command)) return;
  throw cliError(`Unknown command: ${safeText(command)}`);
}

function requiresCleanupConfirmation(command) {
  return command === "proof" || command === "cleanup";
}

function parseConfirmedCommand(command, options) {
  if (options.length === 1 && options[0] === "--confirm-cleanup") {
    return { command, confirmCleanup: true };
  }
  throw cliError(`${command} requires --confirm-cleanup`);
}

function parseOptionlessCommand(command, options) {
  if (options.length === 0) return { command };
  throw cliError(`${command} does not accept options`);
}

async function execute(parsed, repoRoot) {
  if (parsed.command === "health") return { runtime: await health(repoRoot) };
  if (parsed.command === "check") return await check(repoRoot);
  if (parsed.command === "proof") return { proof: await prove(repoRoot) };
  if (parsed.command === "inspect") return { inspection: await inspect(repoRoot) };
  return { cleanup: await cleanup(repoRoot) };
}

async function health(repoRoot) {
  const ports = requireRuntimePorts(repoRoot);
  const response = await fetch(ports.healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`/health returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.status !== "ok") throw new Error("The runtime health response was invalid");

  const fixtureRepo = getRuntimePaths(repoRoot).fixtureRepoDir;
  if (!NodeFS.existsSync(NodePath.join(fixtureRepo, ".git"))) {
    throw new Error("The disposable fixture repository is missing. Run agent:up in this worktree, then retry.");
  }
  requireDesktopBundle(repoRoot);
  requirePlaywright(repoRoot);
  return {
    worktreeIdentity: ports.worktreeIdentity,
    status: payload.status,
    activeAgents: payload.activeAgents,
    desktopBundleReady: true,
    fixtureRepositoryReady: true,
    playwrightReady: true,
  };
}

async function check(repoRoot) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  const stamp = fileStamp();
  const phases = [
    {
      name: "thread-lifecycle-server",
      args: ["run", "--cwd", "apps/server", "test", "--", ...FOCUSED_SERVER_TESTS],
    },
    {
      name: "thread-lifecycle-web",
      args: ["run", "--cwd", "apps/web", "test", "--", ...FOCUSED_WEB_TESTS],
    },
    { name: "lint", args: ["run", "lint"] },
  ];
  const results = [];
  for (const phase of phases) {
    const logPath = NodePath.join(evidenceDirectory, `${stamp}-${phase.name}.log`);
    const exitCode = await runPhase(repoRoot, phase.args, logPath);
    results.push({ name: phase.name, exitCode, logPath: relativePath(repoRoot, logPath) });
    if (exitCode !== 0) break;
  }
  const failed = results.find((result) => result.exitCode !== 0);
  if (failed) throw new Error(`${failed.name} failed. Read ${failed.logPath}.`);
  return { phases: results };
}

async function prove(repoRoot) {
  const proof = createProofContext(repoRoot);
  try {
    await prepareProof(proof);
    const receipt = await captureCompletionProof(proof);
    await validateActiveRunOwnership(proof.socket, proof.repoRoot, proof.evidenceDirectory, proof.record);
    await cleanupRun(proof.socket, proof.evidenceDirectory, proof.record);
    removeActiveRun(proof.evidenceDirectory);
    writeJson(proof.receiptPath, { ...receipt, cleanup: "removed generated project, thread, and worktree" });
    return { receiptPath: relativePath(repoRoot, proof.receiptPath), ...receipt };
  } catch (error) {
    if (!NodeFS.existsSync(NodePath.join(proof.evidenceDirectory, "active-run.json"))) {
      removeOwnedRunDirectory(proof.evidenceDirectory, proof.record.runDirectory, proof.record.id);
    }
    const desktopDiagnostic = await captureDesktopDiagnostic(proof);
    writeJson(proof.failureReceiptPath, {
      ...proof.record,
      desktopDiagnostic,
      failure: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await proof.socket?.close();
    await closeDesktop(proof.desktop, repoRoot);
  }
}

function createProofContext(repoRoot) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  const run = createRun(evidenceDirectory);
  const record = createProofRecord(run);
  return {
    desktop: null,
    evidenceDirectory,
    failureReceiptPath: NodePath.join(evidenceDirectory, "receipts", `${run.id}-failure.json`),
    receiptPath: NodePath.join(evidenceDirectory, "receipts", `${run.id}-receipt.json`),
    record,
    repoRoot,
    socket: null,
  };
}

async function prepareProof(proof) {
  await health(proof.repoRoot);
  proof.desktop = await openDesktop(proof.repoRoot);
  proof.record.desktopRuntimeDirectory = proof.desktop.runtimeDirectory;
  proof.socket = await openDesktopSocket(proof.repoRoot, proof.desktop.runtimeDirectory);
  const prepared = await createProofThread(proof.socket, proof.record, proof.evidenceDirectory, proof.record.id, proof.repoRoot);
  Object.assign(proof, prepared);
  writeActiveRun(proof.evidenceDirectory, proof.record);
}

function createProofRecord(run) {
  return {
    id: run.id,
    desktopRuntimeDirectory: null,
    runDirectory: run.directory,
    workspaceId: null,
    threadId: null,
    worktreePath: null,
  };
}

async function createProofThread(socket, record, evidenceDirectory, runId, repoRoot) {
  const workspace = await findFixtureWorkspace(socket, getRuntimePaths(repoRoot).fixtureRepoDir);
  record.workspaceId = workspace.id;
  const title = expectedThreadTitle(runId);
  const thread = await socket.rpc("thread.create", {
    workspaceId: workspace.id,
    title,
    mode: "worktree",
    branch: "main",
  });
  if (typeof thread?.id !== "string" || typeof thread?.worktree_path !== "string") {
    throw new Error("thread.create did not create a managed worktree thread");
  }
  record.threadId = thread.id;
  record.worktreePath = thread.worktree_path;
  return {
    screenshotPath: NodePath.join(evidenceDirectory, "receipts", `${runId}-completed.png`),
    thread,
    title,
    workspace,
  };
}

/** Finds the fixture workspace registered for this worktree. */
export async function findFixtureWorkspace(socket, fixtureRepoPath) {
  const workspaces = await socket.rpc("workspace.list", {});
  const workspace = Array.isArray(workspaces)
    ? workspaces.find((candidate) => typeof candidate?.id === "string"
      && typeof candidate.path === "string"
      && pathsMatch(candidate.path, fixtureRepoPath))
    : null;
  if (!workspace) throw new Error("The fixture repository is not registered as a project. Restart agent:up, then retry.");
  return workspace;
}

async function captureCompletionProof(proof) {
  await completeThreadInDesktop(
    proof.desktop.page,
    proof.workspace.name,
    proof.title,
    proof.screenshotPath,
  );
  const completed = await findThread(proof.socket, proof.workspace.id, proof.thread.id);
  assertCompletedWorktree(completed, proof.thread.worktree_path);
  return {
    completedAt: completed.user_completed_at,
    scheduledDeletionAt: completed.scheduled_deletion_at,
    screenshotPath: relativePath(proof.desktop.session.repoRoot, proof.screenshotPath),
    threadId: proof.thread.id,
    worktreePath: proof.thread.worktree_path,
    workspaceId: proof.workspace.id,
  };
}

function assertCompletedWorktree(thread, worktreePath) {
  if (!thread?.user_completed_at || !thread.scheduled_deletion_at) {
    throw new Error("The completed thread did not persist its deletion schedule");
  }
  if (!NodeFS.existsSync(worktreePath)) {
    throw new Error("The worktree disappeared before retention cleanup became due");
  }
}

async function inspect(repoRoot) {
  const runtime = await health(repoRoot);
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  const activeRun = readActiveRun(evidenceDirectory);
  const thread = activeRun ? await inspectActiveThread(repoRoot, activeRun) : null;
  const receiptsDirectory = NodePath.join(evidenceDirectory, "receipts");
  const receipts = NodeFS.existsSync(receiptsDirectory)
    ? NodeFS.readdirSync(receiptsDirectory)
      .filter((name) => name.endsWith(".json") || name.endsWith(".png"))
      .sort()
      .map((name) => relativePath(repoRoot, NodePath.join(receiptsDirectory, name)))
    : [];
  return { activeRun, receipts, runtime, thread };
}

async function inspectActiveThread(repoRoot, activeRun) {
  if (!activeRun.workspaceId || !activeRun.threadId) return null;
  const runtimeDirectory = resolveDesktopRuntimeDirectory(repoRoot, activeRun.desktopRuntimeDirectory);
  const socket = await openDesktopSocket(repoRoot, runtimeDirectory);
  try {
    return await findThread(socket, activeRun.workspaceId, activeRun.threadId);
  } finally {
    await socket.close();
  }
}

async function cleanup(repoRoot) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  const activeRun = readActiveRun(evidenceDirectory);
  let activeRunRemoved = false;
  if (activeRun) {
    await health(repoRoot);
    const desktop = await openDesktop(repoRoot);
    const socket = await openDesktopSocket(repoRoot, desktop.runtimeDirectory);
    try {
      await validateActiveRunOwnership(socket, repoRoot, evidenceDirectory, activeRun);
      await cleanupRun(socket, evidenceDirectory, activeRun);
      removeActiveRun(evidenceDirectory);
      activeRunRemoved = true;
    } finally {
      await socket.close();
      await closeDesktop(desktop, repoRoot);
    }
  }
  return { activeRunRemoved, ...cleanupKnownEvidence(evidenceDirectory) };
}

function requireRuntimePorts(repoRoot) {
  const ports = readPortsFile(repoRoot);
  if (!ports) throw new Error("The worktree runtime is not running. Run agent:up, then retry.");
  if (NodePath.resolve(ports.worktreeIdentity).toLowerCase() !== NodePath.resolve(repoRoot).toLowerCase()) {
    throw new Error("ports.json belongs to a different worktree");
  }
  return ports;
}

function requireDesktopBundle(repoRoot) {
  const artifacts = [
    requiredDesktopArtifact(repoRoot, ["apps", "desktop", "dist", "main", "main.cjs"], "Electron main bundle"),
    requiredDesktopArtifact(repoRoot, ["apps", "desktop", "dist", "renderer", "index.html"], "Electron renderer output"),
  ];
  const staleSources = desktopWorkflowSourceFiles(repoRoot).filter((source) => artifacts.some((artifact) => source.modifiedMs > artifact.modifiedMs + FRESHNESS_TOLERANCE_MS));
  if (staleSources.length === 0) return;
  const paths = staleSources.slice(0, 3).map((source) => relativePath(repoRoot, source.path)).join(", ");
  throw actionable(`${staleSources.length} desktop workflow source file(s) are newer than the Electron build artifacts: ${paths}`, `Run ${DESKTOP_BUILD_COMMAND}, then retry.`);
}

function requiredDesktopArtifact(repoRoot, parts, label) {
  const path = NodePath.join(repoRoot, ...parts);
  if (!NodeFS.existsSync(path) || !NodeFS.statSync(path).isFile()) {
    throw actionable(`The ${label} is missing: ${relativePath(repoRoot, path)}`, `Run ${DESKTOP_BUILD_COMMAND}, then retry.`);
  }
  return { path, modifiedMs: NodeFS.statSync(path).mtimeMs };
}

function desktopWorkflowSourceFiles(repoRoot) {
  return DESKTOP_WORKFLOW_SOURCE_DIRECTORIES.flatMap((parts) => sourceFilesUnder(NodePath.join(repoRoot, ...parts)));
}

function sourceFilesUnder(directory) {
  if (!NodeFS.existsSync(directory)) return [];
  const files = [];
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "__tests__") files.push(...sourceFilesUnder(path));
    if (entry.isFile() && !/\.(?:test|spec)\.[^.]+$/i.test(entry.name)) {
      files.push({ path, modifiedMs: NodeFS.statSync(path).mtimeMs });
    }
  }
  return files;
}

function requirePlaywright(repoRoot) {
  const packageFile = NodePath.join(repoRoot, ".dev", "playwright-scratch", "package.json");
  if (!NodeFS.existsSync(packageFile)) {
    throw new Error("Playwright is missing. Run the electorn-live-testing ensure-playwright helper, then retry.");
  }
  const scratchRequire = NodeModule.createRequire(packageFile);
  try {
    return scratchRequire("playwright");
  } catch {
    throw new Error("Playwright is missing. Run the electorn-live-testing ensure-playwright helper, then retry.");
  }
}

function ensureEvidenceDirectory(repoRoot) {
  const runtimePaths = getRuntimePaths(repoRoot);
  const evidenceDirectory = NodePath.join(repoRoot, EVIDENCE_DIRECTORY);
  assertInsideDevDir(evidenceDirectory, runtimePaths.devDir);
  NodeFS.mkdirSync(evidenceDirectory, { recursive: true });
  for (const path of [runtimePaths.devDir, NodePath.join(runtimePaths.devDir, "verification"), evidenceDirectory]) {
    if (NodeFS.lstatSync(path).isSymbolicLink()) throw new Error(`Evidence path is linked: ${relativePath(repoRoot, path)}`);
  }
  return evidenceDirectory;
}

function createRun(evidenceDirectory) {
  const id = `${fileStamp()}-${NodeCrypto.randomUUID()}`;
  const runsDirectory = NodePath.join(evidenceDirectory, "runs");
  NodeFS.mkdirSync(runsDirectory, { recursive: true });
  if (NodeFS.lstatSync(runsDirectory).isSymbolicLink()) {
    throw new Error("The thread-lifecycle runs directory is linked");
  }
  const directory = NodePath.join(runsDirectory, id);
  NodeFS.mkdirSync(directory, { recursive: true });
  return { id, directory };
}

async function openDesktopSocket(repoRoot, runtimeDirectory) {
  const connection = await waitForDesktopServer(repoRoot, runtimeDirectory);
  return openSocket(repoRoot, connection);
}

async function waitForDesktopServer(repoRoot, runtimeDirectory) {
  const resolvedRuntimeDirectory = resolveDesktopRuntimeDirectory(repoRoot, runtimeDirectory);
  let connection = null;
  await waitFor(async () => {
    connection = readDesktopServerConnection(resolvedRuntimeDirectory);
    if (!connection) return false;
    const response = await fetch(`http://127.0.0.1:${connection.port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }).catch(() => null);
    return response?.ok === true;
  }, "The Electron server did not become healthy");
  return connection;
}

function resolveDesktopRuntimeDirectory(repoRoot, runtimeDirectory) {
  if (typeof runtimeDirectory !== "string" || runtimeDirectory.trim() === "") {
    throw new Error("The verification run has no Electron runtime directory");
  }
  const resolvedRuntimeDirectory = NodePath.resolve(runtimeDirectory);
  assertInsideDevDir(resolvedRuntimeDirectory, getRuntimePaths(repoRoot).devDir);
  return resolvedRuntimeDirectory;
}

function readDesktopServerConnection(runtimeDirectory) {
  const lockPath = NodePath.join(runtimeDirectory, "server.lock");
  try {
    const lock = JSON.parse(NodeFS.readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(lock?.port) || lock.port < 1 || lock.port > 65_535) return null;
    if (typeof lock.authToken !== "string" || lock.authToken.length === 0) return null;
    return { authToken: lock.authToken, port: lock.port };
  } catch {
    return null;
  }
}

async function openSocket(repoRoot, connection) {
  const serverRequire = NodeModule.createRequire(NodePath.join(repoRoot, "apps", "server", "package.json"));
  const { WebSocket } = serverRequire("ws");
  const endpoint = new URL(`ws://127.0.0.1:${connection.port}/`);
  endpoint.searchParams.set("token", connection.authToken);
  const ws = new WebSocket(endpoint);
  const pending = new Map();
  const state = { closed: false, failure: null, nextId: 0 };

  const fail = (error) => {
    if (state.failure || state.closed) return;
    state.failure = error instanceof Error ? error : new Error(String(error));
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(state.failure);
    }
    pending.clear();
  };
  ws.on("error", fail);
  ws.on("close", () => fail(new Error("The verification WebSocket closed unexpectedly")));
  ws.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message?.type === "refusal") {
      fail(new Error(`The verification WebSocket was refused: ${String(message.error?.code ?? "UNKNOWN")}`));
      return;
    }
    const entry = pending.get(message?.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`RPC ${entry.method} failed: ${String(message.error.code ?? "UNKNOWN")}`));
      return;
    }
    entry.resolve(message.result);
  });
  await waitForSocketOpen(ws, state, fail);

  return {
    rpc(method, params) {
      if (state.failure) return Promise.reject(state.failure);
      const id = `thread-lifecycle-${++state.nextId}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${method} did not respond within ${HEALTH_TIMEOUT_MS / 1_000} seconds`));
        }, HEALTH_TIMEOUT_MS);
        pending.set(id, { method, resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async close() {
      state.closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("The verification WebSocket closed"));
      }
      pending.clear();
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1_000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.close();
      });
    },
  };
}

function waitForSocketOpen(ws, state, fail) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("The verification WebSocket did not connect within 15 seconds");
      fail(error);
      reject(error);
    }, HEALTH_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      reject(state.failure ?? new Error("The verification WebSocket could not connect"));
    });
  });
}

async function openDesktop(repoRoot) {
  const skillDirectory = NodePath.join(repoRoot, ".codex", "skills", "electorn-live-testing", "scripts");
  const playwright = requirePlaywright(repoRoot);
  const { startElectron } = await import(NodeURL.pathToFileURL(NodePath.join(skillDirectory, "start-electron.mjs")).href);
  const { connectElectronSession, disconnectElectronSession } = await import(
    NodeURL.pathToFileURL(NodePath.join(skillDirectory, "electron-session.mjs")).href,
  );
  const launch = await startElectron(repoRoot, { sessionFileName: ELECTRON_SESSION_FILE });
  const session = await connectElectronSession({
    playwright,
    repoRoot,
    sessionFileName: ELECTRON_SESSION_FILE,
  });
  return {
    disconnectElectronSession,
    page: session.page,
    runtimeDirectory: NodePath.join(launch.userDataDir, "runtime"),
    session,
  };
}

async function closeDesktop(desktop, repoRoot) {
  if (!desktop) return;
  try {
    await desktop.disconnectElectronSession(desktop.session);
  } finally {
    const skillFile = NodePath.join(repoRoot, ".codex", "skills", "electorn-live-testing", "scripts", "stop-electron.mjs");
    const { stopElectron } = await import(NodeURL.pathToFileURL(skillFile).href);
    stopElectron(repoRoot, { sessionFileName: ELECTRON_SESSION_FILE });
  }
}

async function captureDesktopDiagnostic(proof) {
  if (!proof.desktop) return null;
  const screenshotPath = NodePath.join(
    proof.evidenceDirectory,
    "receipts",
    `${proof.record.id}-failure.png`,
  );
  const pageText = await proof.desktop.page.locator("body").innerText().catch(() => "");
  await proof.desktop.page.screenshot({ path: screenshotPath }).catch(() => undefined);
  return {
    pageText: pageText.slice(0, 2_000),
    screenshotPath: relativePath(proof.repoRoot, screenshotPath),
    url: proof.desktop.page.url(),
  };
}

async function completeThreadInDesktop(page, workspaceName, title, screenshotPath) {
  await page.reload({ waitUntil: "domcontentloaded" });
  const expand = page.getByRole("button", { name: `Toggle threads for ${workspaceName}` });
  await expand.waitFor({ state: "visible", timeout: WORKFLOW_TIMEOUT_MS });
  if ((await expand.getAttribute("aria-expanded")) !== "true") await activateControl(expand);

  const complete = page.getByRole("button", { exact: true, name: `Complete ${title}` });
  await complete.waitFor({ state: "visible", timeout: WORKFLOW_TIMEOUT_MS });
  await activateControl(complete);

  const completedView = page.getByRole("button", { name: `View 1 completed thread for ${workspaceName}` });
  await completedView.waitFor({ state: "visible", timeout: WORKFLOW_TIMEOUT_MS });
  await activateControl(completedView);
  const reopen = page.getByRole("button", { exact: true, name: `Reopen ${title}` });
  await reopen.waitFor({ state: "visible", timeout: WORKFLOW_TIMEOUT_MS });
  await page.screenshot({ path: screenshotPath });
}

async function activateControl(control) {
  await control.focus();
  await control.press("Enter");
}

async function findThread(socket, workspaceId, threadId) {
  const threads = await socket.rpc("thread.list", { workspaceId });
  return Array.isArray(threads) ? threads.find((thread) => thread.id === threadId) ?? null : null;
}

async function validateActiveRunOwnership(socket, repoRoot, evidenceDirectory, record) {
  assertActiveRunRecord(evidenceDirectory, record);
  const fixtureRepoPath = getRuntimePaths(repoRoot).fixtureRepoDir;
  const workspace = await findFixtureWorkspace(socket, fixtureRepoPath);
  if (workspace.id !== record.workspaceId) {
    throw activeRunError("does not belong to this worktree's fixture workspace");
  }
  const thread = await findThread(socket, record.workspaceId, record.threadId);
  assertOwnedActiveRun(evidenceDirectory, fixtureRepoPath, record, workspace, thread);
}

/** Validates a persisted run before the verifier deletes a thread or evidence. */
export function assertOwnedActiveRun(evidenceDirectory, fixtureRepoPath, record, workspace, thread) {
  assertActiveRunRecord(evidenceDirectory, record);
  if (!isFixtureWorkspace(workspace, fixtureRepoPath, record.workspaceId)) {
    throw activeRunError("does not identify the fixture workspace for this repository");
  }
  if (!isExpectedThread(record, thread)) {
    throw activeRunError("does not identify the generated managed-worktree thread");
  }
  return record;
}

async function cleanupRun(socket, evidenceDirectory, record) {
  await socket.rpc("thread.delete", { threadId: record.threadId, cleanupWorktree: true });
  await waitFor(async () => {
    const current = await findThread(socket, record.workspaceId, record.threadId);
    return current === null && !NodeFS.existsSync(record.worktreePath);
  }, "The generated worktree cleanup did not finish");
  removeOwnedRunDirectory(evidenceDirectory, record.runDirectory, record.id);
}

async function waitFor(condition, message) {
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

/** Writes a verified run record without following an active-run symlink. */
export function writeActiveRun(evidenceDirectory, record) {
  const path = activeRunPath(evidenceDirectory);
  assertActiveRunFile(path);
  assertActiveRunRecord(evidenceDirectory, record);
  const temporaryPath = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    writeJson(temporaryPath, record);
    assertActiveRunFile(path);
    NodeFS.renameSync(temporaryPath, path);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

/** Reads a verified run record without following an active-run symlink. */
export function readActiveRun(evidenceDirectory) {
  const path = activeRunPath(evidenceDirectory);
  if (!assertActiveRunFile(path)) return null;
  let record;
  try {
    record = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    throw activeRunError("is not valid JSON");
  }
  return assertActiveRunRecord(evidenceDirectory, record);
}

function removeActiveRun(evidenceDirectory) {
  NodeFS.rmSync(activeRunPath(evidenceDirectory), { force: true });
}

function activeRunPath(evidenceDirectory) {
  return NodePath.join(evidenceDirectory, "active-run.json");
}

function assertActiveRunFile(path) {
  let status;
  try {
    status = NodeFS.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (status.isSymbolicLink()) throw activeRunError("is a symbolic link");
  if (!status.isFile()) throw activeRunError("is not a regular file");
  return true;
}

function writeJson(path, value) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertActiveRunRecord(evidenceDirectory, record) {
  assertActiveRunObject(record);
  assertActiveRunIdentifiers(record);
  assertActiveRunPaths(record);
  assertActiveRunDirectory(evidenceDirectory, record);
  return record;
}

function assertActiveRunObject(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw activeRunError("must be an object");
  }
  const expectedKeys = ["desktopRuntimeDirectory", "id", "runDirectory", "threadId", "workspaceId", "worktreePath"];
  if (Object.keys(record).sort().join(",") !== expectedKeys.join(",")) {
    throw activeRunError("has an unexpected shape");
  }
}

function assertActiveRunIdentifiers(record) {
  if (!RUN_ID_PATTERN.test(record.id)) throw activeRunError("has an invalid run ID");
  if (!isSafeId(record.workspaceId) || !isSafeId(record.threadId)) {
    throw activeRunError("has an invalid workspace or thread ID");
  }
}

function assertActiveRunPaths(record) {
  if (!isAbsolutePath(record.desktopRuntimeDirectory) || !isAbsolutePath(record.worktreePath)) {
    throw activeRunError("has an invalid desktop runtime or worktree path");
  }
}

function assertActiveRunDirectory(evidenceDirectory, record) {
  const runsDirectory = NodePath.resolve(evidenceDirectory, "runs");
  const expectedRunDirectory = NodePath.resolve(runsDirectory, record.id);
  if (!isAbsolutePath(record.runDirectory) || !pathsMatch(record.runDirectory, expectedRunDirectory)) {
    throw activeRunError("runDirectory is not the expected direct child of evidenceDirectory/runs");
  }
}

function isFixtureWorkspace(workspace, fixtureRepoPath, workspaceId) {
  return Boolean(workspace)
    && workspace.id === workspaceId
    && typeof workspace.path === "string"
    && pathsMatch(workspace.path, fixtureRepoPath);
}

function isExpectedThread(record, thread) {
  return Boolean(thread)
    && thread.id === record.threadId
    && thread.workspace_id === record.workspaceId
    && thread.mode === "worktree"
    && thread.worktree_managed === true
    && thread.title === expectedThreadTitle(record.id)
    && typeof thread.worktree_path === "string"
    && pathsMatch(thread.worktree_path, record.worktreePath);
}

function expectedThreadTitle(runId) {
  return `Complete worktree ${runId.slice(-8)}`;
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isAbsolutePath(value) {
  return typeof value === "string" && NodePath.isAbsolute(value);
}

function pathsMatch(left, right) {
  const normalizedLeft = NodePath.resolve(left).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRight = NodePath.resolve(right).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function removeOwnedRunDirectory(evidenceDirectory, runDirectory, runId) {
  const runsDirectory = NodePath.resolve(evidenceDirectory, "runs");
  const expectedDirectory = NodePath.resolve(runsDirectory, runId);
  if (!pathsMatch(runDirectory, expectedDirectory)) {
    throw activeRunError("runDirectory changed before cleanup");
  }
  if (NodeFS.existsSync(runsDirectory) && NodeFS.lstatSync(runsDirectory).isSymbolicLink()) {
    throw activeRunError("runs directory is a symbolic link");
  }
  if (!NodeFS.existsSync(runDirectory)) return;
  if (NodeFS.lstatSync(runDirectory).isSymbolicLink()) {
    throw activeRunError("runDirectory is a symbolic link");
  }
  NodeFS.rmSync(runDirectory, { recursive: true, force: true });
}

/** Removes only evidence file names that this verifier creates. */
export function cleanupKnownEvidence(evidenceDirectory) {
  const removed = [
    ...removeKnownFiles(evidenceDirectory, OWNED_LOG_PATTERN),
    ...removeKnownFiles(NodePath.join(evidenceDirectory, "receipts"), OWNED_RECEIPT_PATTERN),
    ...removeEmptyOwnedRunDirectories(NodePath.join(evidenceDirectory, "runs")),
  ];
  removeEmptyDirectory(NodePath.join(evidenceDirectory, "receipts"));
  removeEmptyDirectory(NodePath.join(evidenceDirectory, "runs"));
  const evidenceDirectoryRemoved = removeEmptyDirectory(evidenceDirectory);
  return { evidenceDirectoryRemoved, removed };
}

function removeEmptyOwnedRunDirectories(runsDirectory) {
  if (!NodeFS.existsSync(runsDirectory)) return [];
  const status = NodeFS.lstatSync(runsDirectory);
  if (!status.isDirectory() || status.isSymbolicLink()) return [];
  const removed = [];
  for (const entry of NodeFS.readdirSync(runsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    const directory = NodePath.join(runsDirectory, entry.name);
    if (NodeFS.lstatSync(directory).isSymbolicLink() || NodeFS.readdirSync(directory).length > 0) continue;
    NodeFS.rmdirSync(directory);
    removed.push(directory);
  }
  return removed;
}

function removeKnownFiles(directory, pattern) {
  if (!NodeFS.existsSync(directory)) return [];
  const status = NodeFS.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) return [];
  const removed = [];
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = NodePath.join(directory, entry.name);
    NodeFS.unlinkSync(path);
    removed.push(path);
  }
  return removed;
}

function removeEmptyDirectory(directory) {
  if (!NodeFS.existsSync(directory)) return false;
  const status = NodeFS.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink() || NodeFS.readdirSync(directory).length > 0) return false;
  NodeFS.rmdirSync(directory);
  return true;
}

function activeRunError(condition) {
  return actionable(`active-run.json ${condition}`, "Inspect the thread-lifecycle evidence and correct the record before cleanup.");
}

function cliError(condition) {
  return actionable(condition, "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs thread-lifecycle --help.");
}

function actionable(condition, nextAction) {
  return new Error(`Condition: ${condition}. Next action: ${nextAction}`);
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return safeText(message);
}

function safeText(value) {
  return String(value).replace(/[\r\n\t]+/g, " ").slice(0, 640);
}

async function runPhase(repoRoot, args, logPath) {
  const output = [];
  const environment = { ...process.env };
  delete environment.MCODE_BROWSER_MCP_TOKEN;
  return await new Promise((resolve) => {
    const child = NodeChildProcess.spawn(process.execPath, args, {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("close", (code) => {
      NodeFS.writeFileSync(logPath, Buffer.concat(output));
      resolve(code ?? 1);
    });
  });
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function relativePath(repoRoot, path) {
  return NodePath.relative(repoRoot, path).replace(/\\/g, "/");
}

if (import.meta.main) await main();
