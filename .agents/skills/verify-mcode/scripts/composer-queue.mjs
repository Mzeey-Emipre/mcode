#!/usr/bin/env bun
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  assertInsideDevDir,
  getRuntimePaths,
  resolveRepoRoot,
} from "../../../../scripts/agent/runtime-contract.mjs";
import {
  closeDesktop,
  openDesktop,
  openDesktopSocket,
  verifyThreadLifecycleHealth,
} from "./thread-lifecycle.mjs";
import { openRuntimeVerificationSocket } from "./runtime.mjs";
import { stopElectron } from "../../../../.agents/skills/electorn-live-testing/scripts/stop-electron.mjs";

const EVIDENCE_DIRECTORY = ".dev/verification/composer-queue";
const PROVIDERS = ["codex", "cursor"];
const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
const LIVE_TIMEOUT_MS = 120_000;
const STABLE_STOP_INTERVAL_MS = 1_500;
const ROOT_WAIT_MS = 5_000;
const QUEUE_WAIT_MS = 10_000;
const NAVIGATION_STABILITY_MS = 10_000;
const POLL_INTERVAL_MS = 150;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE_PATTERN = /^electron-composer-queue-(?:codex|cursor|navigation)-[a-f0-9]{8}\.json$/;
const ACTIVE_RUN_PROVIDERS = [...PROVIDERS, "navigation"];
const MODEL_OPTION_KEYS = {
  "--codex-model": "codexModel",
  "--cursor-model": "cursorModel",
};
const CONFIRMATION_OPTION_KEYS = {
  "--allow-enable-cursor": "allowEnableCursor",
  "--confirm-cleanup": "confirmCleanup",
  "--confirm-provider-calls": "confirmProviderCalls",
};

const HELP = `Verify Mcode composer queue

Usage:
  bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue <command> [options]

Commands:
  check
      Run the deterministic Composer queue verifier checks without a provider call.
  health [--codex-model <id>] --cursor-model <id> [--allow-enable-cursor]
      Validate runtime, desktop, Playwright, and both providers without a provider turn. Codex defaults to gpt-5.6-luna.
  proof [--codex-model <id>] --cursor-model <id> --confirm-provider-calls --confirm-cleanup [--allow-enable-cursor]
      Run one production Electron composer queue journey for Codex and one for Cursor.
  navigation-repro --confirm-cleanup
      Launch Electron without a provider call and record navigation readiness without a second reload.
  inspect
      List retained redacted receipts and any interrupted owned run without printing their contents.
  cleanup --confirm-cleanup
      Delete only an interrupted owned direct thread and stop its exact Electron process. Receipts remain.
`;

class MatrixProofError extends Error {
  constructor(results) {
    super("One or more provider proofs failed. Inspect the retained per-provider receipts.");
    this.results = results;
  }
}

/** Carries a retained provider receipt through matrix failure reporting. */
export class ProviderProofError extends Error {
  constructor(message, receiptPath) {
    super(message);
    this.receiptPath = receiptPath;
  }
}

class ProviderReadinessError extends Error {}

async function main() {
  const command = safeText(process.argv[2] ?? "help");
  try {
    const parsed = parseComposerQueueArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    const output = await execute(parsed, resolveRepoRoot());
    process.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, ...output }, null, 2)}\n`);
  } catch (error) {
    const matrix = error instanceof MatrixProofError ? { results: error.results } : {};
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      command,
      failure: safeError(error),
      ...matrix,
    }, null, 2)}\n`);
  }
}

/** Parses the public Composer queue verifier interface without starting Electron. */
export function parseComposerQueueArguments(argv) {
  if (hasHelpArgument(argv)) return { help: true };
  const [command, ...options] = argv;
  return { command, ...parseCommandOptions(command, options) };
}

function hasHelpArgument(argv) {
  return argv.length === 0 || argv.includes("--help") || argv.includes("-h");
}

function parseCommandOptions(command, options) {
  const parser = {
    cleanup: parseCleanupOptions,
    check: parseCheckOptions,
    health: readModelOptions,
    inspect: parseInspectOptions,
    "navigation-repro": parseCleanupOptions,
    proof: parseProofOptions,
  }[command];
  if (!parser) throw cliError(`Unknown command: ${safeText(command)}`);
  return parser(options);
}

function parseInspectOptions(options) {
  if (options.length !== 0) throw cliError("inspect does not accept options");
  return {};
}

function parseCheckOptions(options) {
  if (options.length !== 0) throw cliError("check does not accept options");
  return {};
}

function parseCleanupOptions(options) {
  if (options.length !== 1 || options[0] !== "--confirm-cleanup") {
    throw cliError("cleanup requires --confirm-cleanup");
  }
  return { confirmCleanup: true };
}

function parseProofOptions(options) {
  const values = readModelOptions(options);
  if (!values.confirmProviderCalls) throw cliError("proof requires --confirm-provider-calls");
  if (!values.confirmCleanup) throw cliError("proof requires --confirm-cleanup");
  return values;
}

function readModelOptions(options) {
  const result = {
    allowEnableCursor: false,
    codexModel: null,
    confirmCleanup: false,
    confirmProviderCalls: false,
    cursorModel: null,
  };
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (consumeConfirmationOption(result, option)) continue;
    index = consumeModelOption(result, options, index);
  }
  if (!result.cursorModel) throw cliError("health and proof require --cursor-model <id>");
  return { ...result, codexModel: result.codexModel ?? DEFAULT_CODEX_MODEL };
}

function consumeConfirmationOption(result, option) {
  const key = CONFIRMATION_OPTION_KEYS[option];
  if (!key) return false;
  if (result[key]) throw cliError(`${option} was provided more than once`);
  result[key] = true;
  return true;
}

function consumeModelOption(result, options, index) {
  const option = options[index];
  const key = MODEL_OPTION_KEYS[option];
  if (!key) throw cliError(`Unknown option: ${safeText(option)}`);
  const value = options[index + 1];
  if (typeof value !== "string" || !SAFE_MODEL_PATTERN.test(value)) {
    throw cliError(`${option} requires a safe non-empty model identifier`);
  }
  if (result[key] !== null) throw cliError(`${option} was provided more than once`);
  result[key] = value;
  return index + 1;
}

/** Returns the fixed live provider matrix. It intentionally cannot omit Cursor. */
export function providerMatrix({ codexModel, cursorModel }) {
  return [
    { provider: "codex", model: codexModel },
    { provider: "cursor", model: cursorModel },
  ];
}

async function execute(parsed, repoRoot) {
  if (parsed.command === "check") return { check: await check(repoRoot) };
  if (parsed.command === "health") return { health: await health(repoRoot, parsed) };
  if (parsed.command === "proof") return { results: await proof(repoRoot, parsed) };
  if (parsed.command === "inspect") return { inspection: inspect(repoRoot) };
  if (parsed.command === "navigation-repro") return { repro: await navigationRepro(repoRoot) };
  return { cleanup: await cleanup(repoRoot) };
}

async function check(repoRoot) {
  const child = Bun.spawn({
    cmd: ["bun", "test", "composer-queue.test.mjs"],
    cwd: NodePath.join(repoRoot, ".agents", "skills", "verify-mcode", "scripts"),
    stderr: "inherit",
    stdout: "inherit",
  });
  if (await child.exited !== 0) throw new Error("Composer queue verifier checks failed");
  return { testFile: ".agents/skills/verify-mcode/scripts/composer-queue.test.mjs" };
}

async function health(repoRoot, options) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  if (readActiveRun(evidenceDirectory)) {
    throw new Error("An interrupted Composer queue proof is still active. Run cleanup before health.");
  }
  const lifecycle = await verifyThreadLifecycleHealth(repoRoot);
  const preflight = await runHealthPreflight(repoRoot, options);
  if (preflight.failure) throw new Error(preflight.failure);
  const blocked = preflight.providers.find((provider) => !provider.ready);
  if (blocked) throw new Error(blocked.failure);
  return {
    desktopBundleReady: lifecycle.desktopBundleReady,
    fixtureRepositoryReady: lifecycle.fixtureRepositoryReady,
    playwrightReady: lifecycle.playwrightReady,
    providers: preflight.providers,
    runtimeStatus: lifecycle.status,
  };
}

async function runHealthPreflight(repoRoot, options) {
  let socket = null;
  let providers = [];
  let failure = null;
  try {
    socket = await openRuntimeVerificationSocket(repoRoot);
    providers = await preflightProviders(socket, options);
  } catch (error) {
    failure = safeError(error);
  }
  return finishHealthPreflight(socket, providers, failure);
}

async function finishHealthPreflight(socket, providers, failure) {
  const closeFailure = await closeProviderSocket(socket);
  return {
    failure: closeFailure ?? failure,
    providers,
  };
}

async function preflightProviders(socket, options) {
  const providers = [];
  for (const target of providerMatrix(options)) {
    try {
      providers.push(await preflightProvider(socket, target, options));
    } catch (error) {
      providers.push({
        failure: safeError(error),
        model: target.model,
        provider: target.provider,
        ready: false,
      });
    }
  }
  return providers;
}

async function preflightProvider(socket, target, options) {
  if (target.provider === "cursor" && await cursorNeedsProofLocalEnablement(socket, options.allowEnableCursor)) {
    return {
      model: target.model,
      modelLabel: target.model,
      proofLocalEnablementRequired: true,
      provider: target.provider,
      ready: true,
    };
  }
  const availability = await socket.rpc("providers.listAvailability", {});
  return verifyProviderReadiness(socket, availability, target);
}

/** Reports whether the owned proof session must enable Cursor without changing the worktree settings store. */
export async function cursorNeedsProofLocalEnablement(socket, allowEnableCursor) {
  const settings = await socket.rpc("settings.get", {});
  if (cursorEnabledFromSettings(settings, "settings.get")) return false;
  if (allowEnableCursor) return true;
  throw actionable(
    "Cursor is disabled before the Composer queue proof",
    "Pass --allow-enable-cursor to enable Cursor in the owned Electron proof session.",
  );
}

async function verifyProviderReadiness(socket, availability, target) {
  requireUsableProvider(availability, target.provider);
  const models = await socket.rpc("provider.listModels", { providerId: target.provider });
  const selected = requiredModel(models, target);
  return {
    model: target.model,
    modelLabel: typeof selected?.name === "string" ? selected.name : target.model,
    provider: target.provider,
    ready: true,
  };
}

function requireUsableProvider(availability, provider) {
  const entry = Array.isArray(availability)
    ? availability.find((candidate) => candidate?.id === provider)
    : null;
  if (isProviderUsable(entry)) return;
  throw actionable(
    `${provider} is unavailable before a provider call`,
    "Enable the provider, install or log in to its CLI, then retry health.",
  );
}

function isProviderUsable(entry) {
  return entry?.enabled === true
    && entry.hasAdapter === true
    && entry.comingSoon !== true
    && entry.cli?.status !== "not_found";
}

function requiredModel(models, target) {
  const selected = Array.isArray(models)
    ? models.find((candidate) => candidate?.id === target.model)
    : null;
  if (selected) return selected;
  throw actionable(
    `${target.provider} model ${target.model} is not available`,
    "Pass an exact model returned by provider.listModels, then retry health.",
  );
}

/** Enables Cursor only with explicit consent and leaves a durable restore handle before mutation. */
export async function prepareCursorForVerifier(socket, record, allowEnableCursor, persist) {
  const settings = await socket.rpc("settings.get", {});
  const originallyEnabled = cursorEnabledFromSettings(settings, "settings.get");
  record.cursorOriginalEnabled = originallyEnabled;
  if (originallyEnabled) return false;
  if (!allowEnableCursor) {
    throw actionable(
      "Cursor is disabled before model discovery",
      "Pass --allow-enable-cursor to enable Cursor temporarily and restore its original state after verification.",
    );
  }
  record.cursorRestorePending = true;
  persist();
  const updated = await socket.rpc("settings.update", { provider: { enabled: { cursor: true } } });
  if (!cursorEnabledFromSettings(updated, "settings.update")) {
    throw new Error("settings.update did not enable Cursor for Composer queue verification");
  }
  record.cursorEnabledByVerifier = true;
  persist();
  return true;
}

/** Restores Cursor only when this verifier previously recorded a disabled original state. */
export async function restoreCursorForVerifier(socket, record, persist) {
  if (!record.cursorRestorePending) return false;
  if (record.cursorOriginalEnabled !== false) {
    throw new Error("Composer queue Cursor restoration has no disabled original state");
  }
  const updated = await socket.rpc("settings.update", { provider: { enabled: { cursor: false } } });
  if (cursorEnabledFromSettings(updated, "settings.update")) {
    throw new Error("settings.update did not restore Cursor to its original disabled state");
  }
  record.cursorRestorePending = false;
  persist();
  return true;
}

function cursorEnabledFromSettings(settings, method) {
  const enabled = settings?.provider?.enabled?.cursor;
  if (typeof enabled === "boolean") return enabled;
  throw new Error(`${method} returned an invalid Cursor enabled state`);
}

/** Restores a pending Cursor setting through the proof session's Electron-local socket. */
export async function restoreCursorForTerminalPath(evidenceDirectory, record, socket) {
  if (!record?.cursorRestorePending) return null;
  if (!socket) return "Composer queue Cursor restoration requires the owned Electron-local socket";
  try {
    await restoreCursorForVerifier(socket, record, () => writeActiveRun(evidenceDirectory, record));
    return null;
  } catch (error) {
    return safeError(error);
  }
}

async function proof(repoRoot, options) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  if (readActiveRun(evidenceDirectory)) {
    throw new Error("An interrupted Composer queue proof is still active. Run cleanup before starting another proof.");
  }
  await verifyThreadLifecycleHealth(repoRoot);
  const matrixId = runId();
  const results = await runProviderMatrix(
    providerMatrix(options),
    (target) => runProofTarget(repoRoot, evidenceDirectory, matrixId, options, target),
  );
  writeEvidenceJson(evidenceFile(evidenceDirectory, `${matrixId}-matrix.json`), {
    providers: results.map((result) => ({
      model: result.model,
      provider: result.provider,
      receiptPath: result.receiptPath,
      status: result.status,
    })),
    runId: matrixId,
  });
  if (results.some((result) => result.status !== "passed")) throw new MatrixProofError(results);
  return results;
}

async function runProofTarget(repoRoot, evidenceDirectory, matrixId, options, target) {
  return runProviderProof(repoRoot, evidenceDirectory, matrixId, target, options);
}

async function navigationRepro(repoRoot) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  if (readActiveRun(evidenceDirectory)) {
    throw new Error("An interrupted Composer queue proof is still active. Run cleanup before starting navigation-repro.");
  }
  const run = runId();
  const id = `${run}-navigation-repro`;
  const sessionFileName = `electron-composer-queue-navigation-${NodeCrypto.randomUUID().slice(0, 8)}.json`;
  const record = {
    cursorEnabledByVerifier: false,
    cursorOriginalEnabled: null,
    cursorRestorePending: false,
    electronRuntimeDirectory: null,
    id: `${run}-navigation`,
    marker: run.slice(-8),
    model: "navigation",
    ownsWorkspace: false,
    provider: "navigation",
    sessionFileName,
    threadId: null,
    workspaceCreationPending: false,
    workspaceId: null,
  };
  const receiptPath = evidenceFile(evidenceDirectory, `${id}-receipt.json`);
  const diagnostic = {
    closeEvents: [],
    completed: false,
    id,
    sessionFileName,
    startedAt: new Date().toISOString(),
  };
  let desktop = null;
  let failure = null;
  let cleanupFailure = null;
  try {
    writeActiveRun(evidenceDirectory, record);
    desktop = await openDesktop(repoRoot, sessionFileName);
    observeNavigationLifecycle(desktop, diagnostic);
    diagnostic.initial = pageState(desktop.page, desktop.session.context);
    desktop.page = resolveLiveAppPage(desktop.session.context, desktop.page, desktop.session.appUrl);
    diagnostic.afterReadiness = pageState(desktop.page, desktop.session.context);
    await waitForOpenPage(desktop.page, NAVIGATION_STABILITY_MS);
    diagnostic.afterStabilityWindow = pageState(desktop.page, desktop.session.context);
    diagnostic.completed = true;
  } catch (error) {
    failure = safeError(error);
  } finally {
    diagnostic.electronSignals = recentElectronSignals(repoRoot);
    diagnostic.cleanupStarted = true;
    if (desktop) {
      diagnostic.beforeCleanup = pageState(desktop.page, desktop.session.context);
      cleanupFailure = await closeNavigationDesktop(desktop, repoRoot);
    } else {
      cleanupFailure = stopOrphanedElectron(repoRoot, sessionFileName);
    }
    diagnostic.cleanupFailure = cleanupFailure;
    diagnostic.completedAt = new Date().toISOString();
    writeEvidenceJson(receiptPath, redactNavigationDiagnostic({ ...diagnostic, failure }));
  }
  const finalFailure = finishNavigationRepro(evidenceDirectory, record, failure, cleanupFailure);
  if (finalFailure) throw new ProviderProofError(finalFailure, relativePath(repoRoot, receiptPath));
  return { receiptPath: relativePath(repoRoot, receiptPath) };
}

async function closeNavigationDesktop(desktop, repoRoot) {
  try {
    await closeDesktop(desktop, repoRoot);
    if (NodeFS.existsSync(electronSessionPath(repoRoot, desktop.sessionFileName))) {
      throw new Error("The owned Electron session record remained after cleanup");
    }
    return null;
  } catch (error) {
    return safeError(error);
  }
}

function observeNavigationLifecycle(desktop, diagnostic) {
  const record = (name, page) => diagnostic.closeEvents.push({
    name,
    phase: diagnostic.cleanupStarted ? "cleanup" : "observation",
    pageClosed: page?.isClosed?.() === true,
    timestamp: new Date().toISOString(),
    url: safeAppUrl(page?.url?.()),
  });
  desktop.page.once("close", () => record("page-close", desktop.page));
  desktop.page.once("crash", () => record("page-crash", desktop.page));
  desktop.session.context.once("close", () => record("context-close", desktop.page));
}

function pageState(page, context) {
  return {
    contextPageCount: context.pages().length,
    pageClosed: page.isClosed(),
    url: safeAppUrl(page.url()),
  };
}

async function waitForOpenPage(page, durationMs) {
  if (page.isClosed()) throw new Error("Electron page closed before the navigation stability window");
  await new Promise((resolve, reject) => {
    const onClose = () => reject(new Error("Electron page closed during the no-provider navigation stability window"));
    const timer = setTimeout(resolve, durationMs);
    page.once("close", onClose);
    page.once("crash", onClose);
    page.once("close", () => clearTimeout(timer));
  });
  if (page.isClosed()) throw new Error("Electron page closed during the no-provider navigation stability window");
}

function recentElectronSignals(repoRoot) {
  const logPath = NodePath.join(getRuntimePaths(repoRoot).logsDir, "electron-live-testing.stderr.log");
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8").split(/\r?\n/)
    .filter((line) => /error|crash|fatal|uncaught|exception/i.test(line))
    .slice(-4)
    .map((line) => safeDiagnosticText(line));
}

function redactNavigationDiagnostic(diagnostic) {
  return {
    afterReadiness: diagnostic.afterReadiness,
    afterStabilityWindow: diagnostic.afterStabilityWindow,
    beforeCleanup: diagnostic.beforeCleanup,
    cleanupFailure: diagnostic.cleanupFailure,
    closeEvents: diagnostic.closeEvents,
    cleanupStarted: diagnostic.cleanupStarted === true,
    completed: diagnostic.completed,
    completedAt: diagnostic.completedAt,
    electronSignals: diagnostic.electronSignals,
    failure: diagnostic.failure,
    id: diagnostic.id,
    initial: diagnostic.initial,
    sessionFileName: diagnostic.sessionFileName,
    startedAt: diagnostic.startedAt,
  };
}

function safeAppUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

function safeDiagnosticText(value) {
  return safeText(value)
    .replace(/(token|cookie|authorization|authheader|instancetoken)\s*[=:]\s*[^\s,}\]]+/gi, "$1=<REDACTED>")
    .replace(/https?:\/\/[^\s?]+\?[^\s]+/gi, "<REDACTED_URL_QUERY>");
}

/** Runs providers in order, preserving recovery state before a later provider can start. */
export async function runProviderMatrix(matrix, runProvider) {
  const results = [];
  for (const target of matrix) {
    try {
      results.push(await runProvider(target));
    } catch (error) {
      results.push({
        failure: safeError(error),
        model: target.model,
        provider: target.provider,
        receiptPath: error instanceof ProviderProofError ? error.receiptPath : null,
        status: "failed",
      });
      if (error?.cleanupFailed === true) break;
    }
  }
  return results;
}

function createProviderRunRecord(matrixId, target) {
  const providerRunId = `${matrixId}-${target.provider}`;
  return {
    cursorEnabledByVerifier: false,
    cursorOriginalEnabled: null,
    cursorRestorePending: false,
    electronRuntimeDirectory: null,
    id: providerRunId,
    marker: matrixId.slice(-8),
    model: target.model,
    ownsWorkspace: false,
    provider: target.provider,
    sessionFileName: `electron-composer-queue-${target.provider}-${NodeCrypto.randomUUID().slice(0, 8)}.json`,
    threadId: null,
    workspaceCreationPending: false,
    workspaceId: null,
  };
}

async function runProviderProof(repoRoot, evidenceDirectory, matrixId, target, options) {
  const record = createProviderRunRecord(matrixId, target);
  const providerRunId = record.id;
  const sessionFileName = record.sessionFileName;
  const artifacts = providerArtifacts(evidenceDirectory, providerRunId);
  let desktop = null;
  let socket = null;
  const providerEvents = {
    continueEventIndex: null,
    events: [],
    subscribed: false,
    subscribedBeforeRoot: false,
  };
  const diagnostics = {};
  const steps = [];
  let failure = null;
  let providerBlocked = false;
  let cleanupFailure = null;
  let selectedTarget = target;
  try {
    desktop = await openDesktop(repoRoot, sessionFileName);
    desktop.page = resolveLiveAppPage(desktop.session.context, desktop.page, desktop.session.appUrl);
    record.electronRuntimeDirectory = validateOwnedElectronRuntimeDirectory(repoRoot, record, desktop.runtimeDirectory);
    writeActiveRun(evidenceDirectory, record);
    socket = await openQueueSocket(
      (onPush) => openDesktopSocket(repoRoot, desktop.runtimeDirectory, onPush),
      record,
      providerEvents,
    );
    const readiness = await prepareProviderForProof(socket, target, options, record, () => writeActiveRun(evidenceDirectory, record));
    selectedTarget = { ...target, modelLabel: readiness.modelLabel };
    const workspace = await ensureFixtureWorkspace(socket, repoRoot, record, () => writeActiveRun(evidenceDirectory, record));
    await selectWorkspaceInUi(desktop.page, workspace.name);
    await selectProviderModelInUi(desktop.page, selectedTarget);
    await runQueueJourney(socket, desktop.page, workspace.id, evidenceDirectory, record, artifacts, diagnostics, providerEvents, steps);
  } catch (error) {
    failure = safeError(error);
    providerBlocked = error instanceof ProviderReadinessError;
    if (!providerBlocked) await captureFailureSurface(desktop, artifacts.failure);
  } finally {
    cleanupFailure = await finalizeProviderProof({
      artifacts,
      desktop,
      diagnostics,
      evidenceDirectory,
      failure,
      providerRunId,
      record,
      repoRoot,
      socket,
      steps,
      target: selectedTarget,
    });
    failure ??= cleanupFailure;
  }
  if (failure) {
    if (providerBlocked && !cleanupFailure) {
      return {
        failure,
        model: target.model,
        provider: target.provider,
        receiptPath: relativePath(repoRoot, artifacts.receipt),
        status: "blocked",
      };
    }
    const error = new ProviderProofError(failure, relativePath(repoRoot, artifacts.receipt));
    error.cleanupFailed = cleanupFailure !== null;
    throw error;
  }
  return {
    model: target.model,
    provider: target.provider,
    receiptPath: relativePath(repoRoot, artifacts.receipt),
    status: "passed",
  };
}

/** Prepares the selected provider through the same Electron-local socket that runs the queue journey. */
export async function prepareProviderForProof(socket, target, options, record, persist) {
  try {
    if (target.provider === "cursor") {
      await prepareCursorForVerifier(socket, record, options.allowEnableCursor, persist);
    }
    const availability = await socket.rpc("providers.listAvailability", {});
    return await verifyProviderReadiness(socket, availability, target);
  } catch (error) {
    throw new ProviderReadinessError(safeError(error));
  }
}

/** Ensures queue RPCs and provider events share one Electron-local connection. */
export function requireSameQueueSocket(rpcSocket, eventSocket) {
  if (rpcSocket !== eventSocket) {
    throw new Error("Composer queue RPC and provider events must use the same Electron-local socket");
  }
  return rpcSocket;
}

/** Opens one Electron-local connection that carries both queue RPCs and provider pushes. */
export async function openQueueSocket(openLocalSocket, record, evidence) {
  const socket = await openLocalSocket((push) => recordQueueProviderPush(evidence, record, push));
  return requireSameQueueSocket(socket, socket);
}

async function runQueueJourney(socket, page, workspaceId, evidenceDirectory, record, artifacts, diagnostics, providerEvents, steps) {
  const existingThreadIds = new Set(await threadIds(socket, workspaceId));
  await subscribeBeforeRootSubmission(socket, providerEvents);
  await startRootTurn(page, record);
  record.threadId = await waitForNewDirectThread(socket, workspaceId, existingThreadIds, deadline());
  writeActiveRun(evidenceDirectory, record);
  await subscribeQueueProviderEvents(socket, record.threadId, providerEvents);
  await waitForRootTurnToRun(page);
  await queueMessages(page, [queuePrompt("A", record), queuePrompt("B", record)]);
  await waitForRootAdmission(socket, page, record, deadline(), diagnostics);
  await assertQueueRows(page, [queuePrompt("A", record), queuePrompt("B", record)]);
  steps.push(step("queued-a-and-b"));

  await waitForRootCompletionAndAStart(socket, page, record, deadline(), diagnostics, providerEvents);
  await assertQueueRows(page, [queuePrompt("B", record)]);
  await captureQueueSurface(page, artifacts.afterRoot);
  steps.push(step("root-completed-a-started-b-queued"));

  await queueMessages(page, [queuePrompt("C", record)]);
  await assertQueueRows(page, [queuePrompt("B", record), queuePrompt("C", record)]);
  await stopRunningTurn(page);
  await waitForStopAndStableQueue(socket, page, record, deadline(), ["root", "A"], [queuePrompt("B", record), queuePrompt("C", record)], diagnostics, "stop");
  await assertQueueRows(page, [queuePrompt("B", record), queuePrompt("C", record)]);
  await captureQueueSurface(page, artifacts.afterStop);
  steps.push(step("stop-kept-b-and-c-queued"));

  providerEvents.continueEventIndex = providerEvents.events.length;
  await continueNextQueuedMessage(page);
  await waitForBStart(socket, page, record, deadline(), diagnostics, providerEvents);
  await assertQueueRows(page, [queuePrompt("C", record)]);
  await captureQueueSurface(page, artifacts.afterContinue);
  steps.push(step("continue-started-b-once-c-queued"));

  await stopRunningTurn(page);
  await waitForStopAndStableQueue(socket, page, record, deadline(), ["root", "A", "B"], [queuePrompt("C", record)], diagnostics, "cleanupStop");
  steps.push(step("cleanup-stop-settled"));
}

async function captureFailureSurface(desktop, outputPath) {
  if (desktop) await captureQueueSurface(desktop.page, outputPath).catch(() => undefined);
}

async function finalizeProviderProof(context) {
  const cleanupFailure = await cleanupProviderResources(context);
  writeProviderReceipt(context, cleanupFailure);
  return cleanupFailure;
}

async function cleanupProviderResources({ desktop, evidenceDirectory, record, repoRoot, socket }) {
  const cursorFailure = await restoreCursorForTerminalPath(evidenceDirectory, record, socket);
  if (cursorFailure) {
    await closeProviderSocket(socket);
    return cursorFailure;
  }
  const resourceFailure = await cleanupLiveProviderResources(socket, repoRoot, evidenceDirectory, record);
  const socketFailure = await closeProviderSocket(socket);
  if (resourceFailure || socketFailure) return resourceFailure ?? socketFailure;
  const desktopFailure = desktop
    ? await closeProviderDesktop(desktop, repoRoot)
    : stopOrphanedElectron(repoRoot, record.sessionFileName);
  if (desktopFailure) return desktopFailure;
  return removeActiveRun(evidenceDirectory, record.id);
}

async function cleanupLiveProviderResources(socket, repoRoot, evidenceDirectory, record) {
  if (!socket) return null;
  try {
    await cleanupOwnedRun(socket, repoRoot, evidenceDirectory, record);
    return null;
  } catch (error) {
    return safeError(error);
  }
}

async function closeProviderSocket(socket) {
  if (!socket) return null;
  try {
    await socket.close();
    return null;
  } catch (error) {
    return safeError(error);
  }
}

async function closeProviderDesktop(desktop, repoRoot) {
  try {
    await closeDesktop(desktop, repoRoot);
    if (NodeFS.existsSync(electronSessionPath(repoRoot, desktop.sessionFileName))) {
      throw new Error("The owned Electron session record remained after cleanup");
    }
    return null;
  } catch (error) {
    return safeError(error);
  }
}

function stopOrphanedElectron(repoRoot, sessionFileName) {
  const sessionPath = electronSessionPath(repoRoot, sessionFileName);
  if (!NodeFS.existsSync(sessionPath)) return null;
  try {
    stopElectron(repoRoot, { sessionFileName });
    if (NodeFS.existsSync(sessionPath)) throw new Error("The owned Electron session record remained after cleanup");
    return null;
  } catch (error) {
    return safeError(error);
  }
}

function writeProviderReceipt({ artifacts, diagnostics, failure, providerRunId, record, repoRoot, steps, target }, cleanupFailure) {
  const receipt = redactComposerQueueReceipt({
    artifacts: compactArtifacts(repoRoot, artifacts),
    cleanup: cleanupFailure ? "failed" : "removed-owned-thread-and-electron",
    cursorSettings: cursorSettingEvidence(record),
    diagnostics,
    failure: failure ?? cleanupFailure,
    model: target.model,
    provider: target.provider,
    runId: providerRunId,
    steps,
    threadId: record.threadId,
    timestamps: { completedAt: new Date().toISOString() },
    workspaceId: record.workspaceId,
  });
  writeEvidenceJson(artifacts.receipt, receipt);
}

/** Returns receipt-safe evidence only after this verifier enabled and restored Cursor. */
export function cursorSettingEvidence(record) {
  if (record.provider !== "cursor" || record.cursorOriginalEnabled !== false || !record.cursorEnabledByVerifier) return null;
  return { originalEnabled: false, restoredBeforeCleanup: !record.cursorRestorePending };
}

/** Finds the fixture workspace or records uncertain ownership before creating one. */
export async function ensureFixtureWorkspace(socket, repoRoot, record, persist) {
  const fixturePath = getRuntimePaths(repoRoot).fixtureRepoDir;
  const workspaces = await socket.rpc("workspace.list", {});
  const existing = Array.isArray(workspaces)
    ? workspaces.find((workspace) => pathsMatch(workspace?.path, fixturePath))
    : null;
  if (existing?.id && existing.name) {
    record.workspaceId = existing.id;
    persist();
    return existing;
  }
  record.workspaceCreationPending = true;
  persist();
  const workspace = await socket.rpc("workspace.create", {
    name: `Composer queue ${record.provider} ${record.marker}`,
    path: fixturePath,
  });
  if (!isSafeId(workspace?.id) || typeof workspace?.name !== "string") {
    throw new Error("workspace.create did not return the owned fixture workspace");
  }
  record.ownsWorkspace = true;
  record.workspaceCreationPending = false;
  record.workspaceId = workspace.id;
  persist();
  return workspace;
}

async function selectWorkspaceInUi(page, workspaceName) {
  const picker = page.getByTestId("new-thread-project-picker");
  await picker.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  await picker.click();
  const option = page.getByRole("option", { name: workspaceName, exact: true });
  await option.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  await option.click();
  await composerEditor(page).waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
}

export async function selectProviderModelInUi(page, target) {
  await ensureModelSelectorOpen(page);
  const provider = page.getByTestId(`model-group-${target.provider}`);
  await provider.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  if (await provider.isDisabled()) throw new Error(`${target.provider} is disabled in the production model selector`);
  if (await provider.getAttribute("aria-current") !== "true") await provider.click();
  const search = page.getByTestId("model-selector-panel-search");
  await search.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  await search.fill(target.modelLabel ?? target.model);
  const label = target.modelLabel ?? target.model;
  const selected = page.getByRole("button", { exact: true, name: `${label}, selected` });
  if (!await selected.isVisible().catch(() => false)) {
    const candidate = page.getByRole("button", { exact: true, name: `Select ${label}` });
    await candidate.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
    await candidate.click();
  }
  await assertSelectedProviderModel(page, target, label);
}

async function assertSelectedProviderModel(page, target, label) {
  await ensureModelSelectorOpen(page);
  const provider = page.getByTestId(`model-group-${target.provider}`);
  await provider.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  if (await provider.getAttribute("aria-current") !== "true") {
    throw new Error(`The production model selector did not retain provider ${target.provider}`);
  }
  const search = page.getByTestId("model-selector-panel-search");
  await search.fill(label);
  const selected = page.getByRole("button", { exact: true, name: `${label}, selected` });
  await selected.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  if (await selected.getAttribute("aria-current") !== "true") {
    throw new Error(`The production model selector did not retain model ${target.model}`);
  }
  await closeModelSelector(page);
}

async function ensureModelSelectorOpen(page) {
  const trigger = page.getByTestId("model-selector-trigger");
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}

async function closeModelSelector(page) {
  const trigger = page.getByTestId("model-selector-trigger");
  if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();
}

export async function startRootTurn(page, record) {
  const editor = composerEditor(page);
  await editor.fill(rootPrompt(record));
  await page.getByRole("button", { name: "Send message" }).click();
}

export async function waitForRootTurnToRun(page) {
  const editor = composerEditor(page);
  await page.getByRole("button", { name: "Stop agent" }).waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  if ((await editor.textContent())?.trim()) throw new Error("The root turn did not clear the composer before queueing");
}

export async function queueMessages(page, prompts) {
  const editor = composerEditor(page);
  for (const prompt of prompts) {
    await editor.fill(prompt);
    const queueButton = page.getByRole("button", { name: "Queue message" });
    await queueButton.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
    await queueButton.click();
  }
}

function composerEditor(page) {
  return page.getByTestId("composer-surface").getByRole("textbox");
}

/** Returns the active worktree app page after a renderer navigation replaces a prior handle. */
export function resolveLiveAppPage(context, page, appUrl) {
  if (!page.isClosed() && page.url().startsWith(appUrl)) return page;
  const replacement = context.pages().find((candidate) => !candidate.isClosed() && candidate.url().startsWith(appUrl));
  if (replacement) return replacement;
  throw new Error("No live Electron app page remained after navigation");
}

export async function assertQueueRows(page, expectedPrompts) {
  const rows = await queueRows(page);
  if (rows.length !== expectedPrompts.length || rows.some((row, index) => row !== expectedPrompts[index])) {
    throw new Error("The visible queued rows did not exactly match the expected FIFO prompts");
  }
}

async function queueRows(page) {
  const section = page.getByRole("region", { name: "Queued messages" });
  await section.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  const removeButtons = await section.getByRole("button", { name: /^Remove queued message \d+$/ }).all();
  return Promise.all(removeButtons.map(async (button) => {
    const row = button.locator("xpath=ancestor::div[.//button[@aria-label='Reorder message (drag, or press space then arrow keys)']][1]");
    return (await row.innerText()).trim();
  }));
}

async function waitForNewDirectThread(socket, workspaceId, before, until) {
  const result = await waitForBounded(async () => {
    const threads = await socket.rpc("thread.list", { workspaceId });
    const created = Array.isArray(threads)
      ? threads.filter((thread) => !before.has(thread?.id) && thread?.mode === "direct")
      : [];
    return created.length === 1 && isSafeId(created[0].id) ? created[0].id : null;
  }, until, "The UI did not create exactly one owned direct thread");
  return result;
}

export async function waitForRootCompletionAndAStart(socket, page, record, until, diagnostics, providerEvents = null) {
  await waitForBounded(async () => {
    const durable = await durablePromptObservation(socket, record);
    const queuedRows = await queueRows(page);
    const running = await hasStopControl(page);
    const observation = {
      durable,
      queueMatchesExpected: rowsMatch(queuedRows, [queuePrompt("B", record)]),
      queueRowCount: queuedRows.length,
      running,
      ...rootProviderEventObservation(record, providerEvents),
    };
    if (diagnostics) diagnostics.rootCompletion = observation;
    return liveQueueSeamObserved(observation, ["root", "A"]);
  }, until, "Root completion did not start A exactly once with B still queued");
}

function rootProviderEventObservation(record, providerEvents) {
  if (!providerEvents) return {};
  return {
    providerEvents: {
      ...verifyQueueProviderEvidence(record.provider, record.threadId, providerEvents.events, null),
      subscribed: providerEvents.subscribed,
      subscribedBeforeRoot: providerEvents.subscribedBeforeRoot,
    },
  };
}

/** Applies the public UI and durable-message requirements for a queued-message admission. */
export function liveQueueSeamObserved(observation, expectedLabels) {
  return exactDurablePrompts(observation.durable, expectedLabels)
    && observation.running
    && observation.queueMatchesExpected;
}

/** Activates the Electron-local push connection before the composer submits the root turn. */
export async function subscribeBeforeRootSubmission(socket, evidence) {
  const subscription = await socket.rpc("push.setThreadSubscriptions", { threadIds: [] });
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) {
    throw new Error("push.setThreadSubscriptions returned an invalid response");
  }
  evidence.subscribedBeforeRoot = true;
}

async function subscribeQueueProviderEvents(socket, threadId, evidence) {
  const subscription = await socket.rpc("push.setThreadSubscriptions", {
    cursors: { [threadId]: 0 },
    threadIds: [threadId],
  });
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) {
    throw new Error("push.setThreadSubscriptions returned an invalid response");
  }
  evidence.subscribed = true;
}

function recordQueueProviderPush(evidence, record, push) {
  if (push?.channel !== "agent.event" || push.data?.threadId !== record.threadId || typeof push.data.type !== "string") return;
  evidence.events.push({
    channel: "agent.event",
    data: {
      outcome: safeEventOutcome(push.data.outcome),
      threadId: record.threadId,
      turnExecutionId: safeTurnExecutionId(push.data.turnExecutionId),
      type: push.data.type,
    },
  });
  if (evidence.events.length > 40) evidence.events.shift();
}

function safeEventOutcome(value) {
  return value === "completed" || value === "success" ? "completed" : null;
}

/** Summarizes redacted thread-local terminal evidence without retaining event payloads. */
export function summarizeQueueProviderEvents(threadId, pushes) {
  const evidence = verifyQueueTurnEvidence(threadId, pushes, null);
  return {
    providerTerminalObserved: evidence.providerTerminalObserved,
    terminalEventCount: evidence.terminalEventCount,
    turnStartedEventCount: evidence.turnStartedEventCount,
  };
}

/** Adds Cursor's completed terminal-pair evidence to generic event observations. */
export function verifyQueueProviderEvidence(provider, threadId, pushes, continueEventIndex) {
  const evidence = verifyQueueTurnEvidence(threadId, pushes, continueEventIndex);
  if (provider !== "cursor") return evidence;
  return { ...evidence, ...cursorRootTerminalEvidence(queueEventsForThread(threadId, pushes)) };
}

/** Verifies the redacted start and terminal ordering needed for the queue journey. */
export function verifyQueueTurnEvidence(threadId, pushes, continueEventIndex) {
  const events = queueEventsForThread(threadId, pushes);
  const startIndices = eventIndices(events, (event) => event.type === "turnStarted");
  const root = rootTurnEvidence(events, startIndices);
  const a = aStartEvidence(startIndices, root, continueEventIndex, events.length);
  const b = bStartEvidence(startIndices, a.rangeEnd, continueEventIndex, a.started);
  const terminalEventCount = logicalTerminalCount(events);
  return {
    aStartedAfterRootTerminal: a.started,
    bStartedAfterContinue: b.started,
    providerTerminalObserved: terminalEventCount > 0,
    rootStarted: root.started,
    rootTerminalObserved: root.terminalObserved,
    aStartEventCount: a.count,
    bStartEventCount: b.count,
    rootStartEventCount: root.startCount,
    terminalEventCount,
    turnStartedEventCount: startIndices.length,
  };
}

function cursorRootTerminalEvidence(events) {
  const rootIndex = events.findIndex((event) => event.type === "turnComplete");
  if (rootIndex < 0) {
    return { cursorRootTerminalObserved: false, cursorRootTerminalSequenceCount: 0 };
  }
  const root = events[rootIndex];
  const turnCompleteCount = events.filter((event) => event.type === "turnComplete"
    && sameTurnOrUnidentified(root, event)).length;
  const completedEndIndices = eventIndices(events, (event) => event.type === "ended"
    && event.outcome === "completed"
    && sameTurnOrUnidentified(root, event));
  const completedEndedCount = completedEndIndices.length;
  return {
    cursorRootTerminalObserved: turnCompleteCount === 1
      && completedEndedCount === 1
      && completedEndIndices[0] > rootIndex,
    cursorRootTerminalSequenceCount: Math.max(turnCompleteCount, completedEndedCount),
  };
}

function sameTurnOrUnidentified(left, right) {
  return left.turnExecutionId === null || right.turnExecutionId === null
    || left.turnExecutionId === right.turnExecutionId;
}

function queueEventsForThread(threadId, pushes) {
  if (!Array.isArray(pushes)) return [];
  return pushes.filter((push) => push?.channel === "agent.event" && push.data?.threadId === threadId)
    .map((push) => ({
      outcome: safeEventOutcome(push.data.outcome),
      turnExecutionId: safeTurnExecutionId(push.data.turnExecutionId),
      type: push.data.type,
    }));
}

function rootTurnEvidence(events, startIndices) {
  const startIndex = events.findIndex((event) => event.type === "turnStarted");
  if (startIndex < 0 || events.slice(0, startIndex).some(isCompletedTerminalEvent)) {
    return { startCount: 0, started: false, terminalIndex: -1, terminalObserved: false };
  }
  const executionId = events[startIndex].turnExecutionId;
  const terminalIndex = events.findIndex((event, index) => index > startIndex
    && isRootCompletedTerminal(events, event, index, startIndex, executionId));
  const startCount = rootStartCount(events, startIndices, executionId, terminalIndex);
  return {
    startCount,
    started: true,
    terminalIndex,
    terminalObserved: terminalIndex >= 0 && startCount === 1,
  };
}

function rootStartCount(events, startIndices, executionId, terminalIndex) {
  if (terminalIndex < 0) return 1;
  if (executionId !== null) return startCountForExecution(events, executionId, 0, events.length);
  return startIndices.filter((index) => index < terminalIndex).length;
}

function aStartEvidence(startIndices, root, continueEventIndex, eventCount) {
  const rangeEnd = queueRangeEnd(continueEventIndex, eventCount);
  const count = root.terminalIndex < 0
    ? 0
    : startIndices.filter((index) => index > root.terminalIndex && index < rangeEnd).length;
  return { count, rangeEnd, started: root.terminalObserved && count === 1 };
}

function bStartEvidence(startIndices, rangeEnd, continueEventIndex, aStarted) {
  const count = Number.isInteger(continueEventIndex)
    ? startIndices.filter((index) => index >= rangeEnd).length
    : 0;
  return { count, started: aStarted && count === 1 };
}

function queueRangeEnd(continueEventIndex, eventCount) {
  if (!Number.isInteger(continueEventIndex)) return eventCount;
  return Math.min(Math.max(continueEventIndex, 0), eventCount);
}

function safeTurnExecutionId(value) {
  return isSafeId(value) ? value : null;
}

function eventIndices(events, predicate) {
  return events.flatMap((event, index) => predicate(event, index) ? [index] : []);
}

function startCountForExecution(events, executionId, start, end) {
  return events.slice(start, end).filter((event) => event.type === "turnStarted"
    && (executionId === null || event.turnExecutionId === executionId)).length;
}

function isRootCompletedTerminal(events, event, index, rootStartIndex, rootExecutionId) {
  if (!isCompletedTerminalEvent(event)) return false;
  if (rootExecutionId !== null && event.turnExecutionId !== null) {
    return event.turnExecutionId === rootExecutionId;
  }
  return startCountForExecution(events, null, 0, index) === 1 && index > rootStartIndex;
}

function isCompletedTerminalEvent(event) {
  return event.type === "turnComplete" || (event.type === "ended" && event.outcome === "completed");
}

function logicalTerminalCount(events) {
  const identities = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isCompletedTerminalEvent(event)) continue;
    const identity = event.turnExecutionId ?? `anonymous-${startCountForExecution(events, null, 0, index)}`;
    identities.add(identity);
  }
  return identities.size;
}

async function waitForRootAdmission(socket, page, record, until, diagnostics) {
  await waitForBounded(async () => {
    const durable = await durablePromptObservation(socket, record);
    const queuedRows = await queueRows(page);
    const observation = {
      durable,
      queueMatchesExpected: rowsMatch(queuedRows, [queuePrompt("A", record), queuePrompt("B", record)]),
      queueRowCount: queuedRows.length,
      running: await hasStopControl(page),
    };
    if (diagnostics) diagnostics.rootAdmission = observation;
    return exactDurablePrompts(durable, ["root"])
      && observation.running
      && observation.queueMatchesExpected;
  }, until, "The root turn did not retain its exact durable prompt while A and B stayed queued");
}

async function waitForStopAndStableQueue(socket, page, record, until, expectedLabels = ["root", "A"], expectedQueue = [queuePrompt("B", record), queuePrompt("C", record)], diagnostics, diagnosticKey) {
  await waitForBounded(async () => {
    const continueButton = page.getByRole("button", { name: "Send next queued message" });
    const durable = await durablePromptObservation(socket, record);
    const queuedRows = await queueRows(page);
    const observation = {
      continueVisible: await continueButton.isVisible().catch(() => false),
      durable,
      queueMatchesExpected: rowsMatch(queuedRows, expectedQueue),
      queueRowCount: queuedRows.length,
    };
    if (diagnostics && diagnosticKey) diagnostics[diagnosticKey] = observation;
    return exactDurablePrompts(durable, expectedLabels)
      && rowsMatch(queuedRows, expectedQueue)
      && observation.continueVisible;
  }, until, "Stop did not settle with Continue visible");
  const before = await durablePromptObservation(socket, record);
  const beforeRows = await queueRows(page);
  await new Promise((resolve) => setTimeout(resolve, STABLE_STOP_INTERVAL_MS));
  const after = await durablePromptObservation(socket, record);
  const afterRows = await queueRows(page);
  if (!exactDurablePrompts(before, expectedLabels)
    || !exactDurablePrompts(after, expectedLabels)
    || !rowsMatch(beforeRows, expectedQueue)
    || !rowsMatch(afterRows, expectedQueue)) {
    throw new Error("A queued message started during the bounded Stop stability interval");
  }
}

async function continueNextQueuedMessage(page) {
  const button = page.getByRole("button", { name: "Send next queued message" });
  await button.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  await button.click();
}

async function waitForBStart(socket, page, record, until, diagnostics, providerEvents) {
  await waitForBounded(async () => {
    const durable = await durablePromptObservation(socket, record);
    const queuedRows = await queueRows(page);
    const observation = {
      durable,
      queueMatchesExpected: rowsMatch(queuedRows, [queuePrompt("C", record)]),
      queueRowCount: queuedRows.length,
      running: await hasStopControl(page),
      ...(providerEvents ? {
        providerEvents: {
          ...verifyQueueProviderEvidence(record.provider, record.threadId, providerEvents.events, providerEvents.continueEventIndex),
          subscribedBeforeRoot: providerEvents.subscribedBeforeRoot,
          subscribed: providerEvents.subscribed,
        },
      } : {}),
    };
    if (diagnostics) diagnostics.continue = observation;
    return liveQueueSeamObserved(observation, ["root", "A", "B"]);
  }, until, "Continue did not start B exactly once with C still queued");
}

async function stopRunningTurn(page) {
  const composer = page.getByTestId("composer-surface");
  const stop = composer.getByRole("button", { name: "Stop agent" });
  await stop.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
  await stop.first().click();
}

async function hasStopControl(page) {
  return await page.getByTestId("composer-surface").getByRole("button", { name: "Stop agent" })
    .isVisible()
    .catch(() => false);
}

async function durablePromptObservation(socket, record) {
  const page = await socket.rpc("message.list", { threadId: record.threadId, limit: 100 });
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  const expected = new Map([
    ["root", rootPrompt(record)],
    ["A", queuePrompt("A", record)],
    ["B", queuePrompt("B", record)],
    ["C", queuePrompt("C", record)],
  ]);
  const userMessages = messages.filter((message) => message?.role === "user");
  return {
    exactPromptCounts: Object.fromEntries([...expected].map(([label, prompt]) => [
      label,
      userMessages.filter((message) => message?.content === prompt).length,
    ])),
    unexpectedUserMessageCount: userMessages.filter((message) => ![...expected.values()].includes(message?.content)).length,
    userMessageCount: userMessages.length,
  };
}

function exactDurablePrompts(observation, labels) {
  return observation.userMessageCount === labels.length
    && observation.unexpectedUserMessageCount === 0
    && Object.entries(observation.exactPromptCounts).every(([label, count]) => count === (labels.includes(label) ? 1 : 0));
}

function rowsMatch(rows, expected) {
  return rows.length === expected.length && rows.every((row, index) => row === expected[index]);
}

async function captureQueueSurface(page, outputPath) {
  const queue = page.getByRole("region", { name: "Queued messages" });
  const composer = page.getByTestId("composer-surface");
  const [queueBox, composerBox] = await Promise.all([queue.boundingBox(), composer.boundingBox()]);
  if (!queueBox || !composerBox) throw new Error("The queue or composer was not visible for an evidence screenshot");
  const x = Math.min(queueBox.x, composerBox.x);
  const y = Math.min(queueBox.y, composerBox.y);
  const right = Math.max(queueBox.x + queueBox.width, composerBox.x + composerBox.width);
  const bottom = Math.max(queueBox.y + queueBox.height, composerBox.y + composerBox.height);
  await page.screenshot({ path: outputPath, clip: { x, y, width: right - x, height: bottom - y } });
}

/** Deletes only a verified harness-created direct thread and its optional workspace. */
export async function cleanupOwnedRun(socket, repoRoot, evidenceDirectory, record) {
  assertActiveRecord(evidenceDirectory, record);
  if (record.workspaceCreationPending) {
    throw new Error("The interrupted Composer queue workspace ownership is uncertain after a lost create response");
  }
  if (!record.workspaceId) {
    if (record.ownsWorkspace) throw new Error("The interrupted Composer queue proof is missing its owned workspace identifier");
    return { deletedThread: false, stoppedWorkspace: false };
  }
  await requireFixtureWorkspace(socket, repoRoot, record.workspaceId);
  const deletedThread = record.threadId
    ? await deleteOwnedDirectThread(socket, record.workspaceId, record.threadId)
    : false;
  const stoppedWorkspace = await deleteOwnedWorkspace(socket, record);
  await verifyOwnedResourcesRemoved(socket, record);
  return { deletedThread, stoppedWorkspace };
}

async function requireFixtureWorkspace(socket, repoRoot, workspaceId) {
  const workspaces = requireRpcArray(await socket.rpc("workspace.list", {}), "workspace.list");
  const workspace = workspaces.find((candidate) => candidate?.id === workspaceId);
  if (workspace && pathsMatch(workspace.path, getRuntimePaths(repoRoot).fixtureRepoDir)) return;
  throw new Error("The owned Composer queue workspace no longer matches this worktree fixture");
}

async function deleteOwnedDirectThread(socket, workspaceId, threadId) {
  const threads = requireRpcArray(await socket.rpc("thread.list", { workspaceId }), "thread.list");
  const thread = threads.find((candidate) => candidate?.id === threadId);
  requireDirectThread(thread, workspaceId);
  if (!thread) return false;
  await socket.rpc("thread.delete", { threadId, cleanupWorktree: false });
  await waitForBounded(async () => !(await threadIds(socket, workspaceId)).includes(threadId), deadline(), "The owned direct thread was not removed");
  return true;
}

function requireDirectThread(thread, workspaceId) {
  if (!thread) return;
  if (thread.workspace_id === workspaceId && thread.mode === "direct") return;
  throw new Error("The owned Composer queue thread no longer identifies a direct fixture thread");
}

async function deleteOwnedWorkspace(socket, record) {
  if (!record.ownsWorkspace) return false;
  const deleted = await socket.rpc("workspace.delete", { id: record.workspaceId });
  if (deleted !== true) throw new Error("workspace.delete did not remove the owned Composer queue workspace");
  await waitForBounded(async () => {
    const workspaces = requireRpcArray(await socket.rpc("workspace.list", {}), "workspace.list");
    return !workspaces.some((workspace) => workspace?.id === record.workspaceId);
  }, deadline(), "The owned Composer queue workspace was not removed");
  return true;
}

async function verifyOwnedResourcesRemoved(socket, record) {
  if (record.threadId) {
    const remainingThreadIds = await threadIds(socket, record.workspaceId);
    if (remainingThreadIds.includes(record.threadId)) {
      throw new Error("The owned Composer queue thread remained after cleanup");
    }
  }
  if (!record.ownsWorkspace) return;
  const workspaces = requireRpcArray(await socket.rpc("workspace.list", {}), "workspace.list");
  if (workspaces.some((workspace) => workspace?.id === record.workspaceId)) {
    throw new Error("The owned Composer queue workspace remained after cleanup");
  }
}

async function threadIds(socket, workspaceId) {
  const threads = requireRpcArray(await socket.rpc("thread.list", { workspaceId }), "thread.list");
  return threads.map((thread) => thread?.id).filter(isSafeId);
}

function requireRpcArray(value, method) {
  if (Array.isArray(value)) return value;
  throw new Error(`${method} returned an invalid response`);
}

function inspect(repoRoot) {
  const evidenceDirectory = resolveEvidenceDirectory(repoRoot, false);
  const receipts = listKnownReceipts(repoRoot, evidenceDirectory);
  const activeRun = readActiveRun(evidenceDirectory);
  return { activeRun: activeRun ? { provider: activeRun.provider, runId: activeRun.id } : null, receipts };
}

async function cleanup(repoRoot) {
  const evidenceDirectory = resolveEvidenceDirectory(repoRoot, false);
  const record = readActiveRun(evidenceDirectory);
  if (!record) return { activeRunRemoved: false, evidencePreserved: true };
  const resourceFailure = !requiresInterruptedQueueSocket(record) || record.provider === "navigation"
    ? null
    : await cleanupInterruptedQueueRun(repoRoot, evidenceDirectory, record);
  const electronFailure = resourceFailure || record.electronRuntimeDirectory === null
    ? null
    : stopInterruptedElectron(repoRoot, record.sessionFileName);
  const failure = finishInterruptedCleanup(evidenceDirectory, record, resourceFailure, electronFailure);
  if (failure) throw new Error(failure);
  return { activeRunRemoved: true, evidencePreserved: true };
}

function hasOwnedQueueResources(record) {
  return record.workspaceCreationPending || record.workspaceId !== null || record.threadId !== null;
}

function requiresInterruptedQueueSocket(record) {
  return record.cursorRestorePending || hasOwnedQueueResources(record);
}

/** Removes the recovery record only after both owned resource and Electron cleanup succeed. */
export function finishInterruptedCleanup(evidenceDirectory, record, resourceFailure, electronFailure) {
  const failure = resourceFailure ?? electronFailure;
  if (failure) return failure;
  return removeActiveRun(evidenceDirectory, record.id);
}

/** Keeps navigation recovery metadata only when its exact Electron session remains unresolved. */
export function finishNavigationRepro(evidenceDirectory, record, operationFailure, electronFailure) {
  if (electronFailure) return electronFailure;
  const removalFailure = removeActiveRun(evidenceDirectory, record.id);
  return operationFailure ?? removalFailure;
}

/** Restores owned Cursor state and removes owned queue resources through one Electron-local socket. */
export async function cleanupInterruptedQueueRun(repoRoot, evidenceDirectory, record, openSocket = openInterruptedQueueSocket, removeResources = cleanupOwnedRun) {
  let socket = null;
  let failure = null;
  try {
    socket = await openSocket(repoRoot, record);
    failure = await restoreCursorForTerminalPath(evidenceDirectory, record, socket);
    if (!failure && hasOwnedQueueResources(record)) {
      await removeResources(socket, repoRoot, evidenceDirectory, record);
    }
  } catch (error) {
    failure = safeError(error);
  } finally {
    if (socket) {
      try {
        await socket.close();
      } catch (error) {
        failure ??= safeError(error);
      }
    }
  }
  return failure;
}

/** Reopens only the Electron-local server that created the owned queue thread. */
export async function openInterruptedQueueSocket(repoRoot, record, openSocket = openDesktopSocket) {
  const runtimeDirectory = validateOwnedElectronRuntimeDirectory(repoRoot, record);
  return openSocket(repoRoot, runtimeDirectory);
}

/** Validates the persisted runtime path belongs to this exact owned Electron session. */
export function validateOwnedElectronRuntimeDirectory(repoRoot, record, runtimeDirectory = record?.electronRuntimeDirectory) {
  requireOwnedElectronRuntimeRecord(record, runtimeDirectory);
  const devDirectory = getRuntimePaths(repoRoot).devDir;
  const sessionDirectory = NodePath.join(devDirectory, NodePath.basename(record.sessionFileName, ".json"));
  const expectedRuntimeDirectory = NodePath.join(sessionDirectory, "runtime");
  const resolvedRuntimeDirectory = NodePath.resolve(runtimeDirectory);
  if (!pathsMatch(resolvedRuntimeDirectory, expectedRuntimeDirectory)) {
    throw new Error("Composer queue recovery runtime directory does not identify the owned Electron session");
  }
  assertInsideDevDir(resolvedRuntimeDirectory, devDirectory);
  requireNormalElectronRuntimeDirectories([devDirectory, sessionDirectory, resolvedRuntimeDirectory]);
  return resolvedRuntimeDirectory;
}

function requireOwnedElectronRuntimeRecord(record, runtimeDirectory) {
  if (typeof runtimeDirectory !== "string" || runtimeDirectory.length === 0) {
    throw new Error("Composer queue recovery is missing the owned Electron runtime directory");
  }
  if (!record || typeof record.sessionFileName !== "string") {
    throw new Error("Composer queue recovery is missing its owned Electron session");
  }
}

function requireNormalElectronRuntimeDirectories(paths) {
  for (const path of paths) {
    if (!NodeFS.existsSync(path)) throw new Error("Composer queue recovery Electron runtime directory is linked or unavailable");
    const stat = NodeFS.lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Composer queue recovery Electron runtime directory is linked or unavailable");
    }
  }
}

function stopInterruptedElectron(repoRoot, sessionFileName) {
  try {
    const stopped = stopElectron(repoRoot, { sessionFileName });
    if (!isStoppedElectronSession(stopped, NodeFS.existsSync(electronSessionPath(repoRoot, sessionFileName)))) {
      throw new Error("The exact interrupted Electron session could not be verified as stopped");
    }
    return null;
  } catch (error) {
    return safeError(error);
  }
}

/** Treats an exact missing session as already stopped without launching a replacement. */
export function isStoppedElectronSession(result, sessionFileExists) {
  return ["stopped", "not-running", "already-stopped"].includes(result?.status) && !sessionFileExists;
}

/** Removes private values while retaining the public proof outcome. */
export function redactComposerQueueReceipt(value) {
  const diagnostics = redactJourneyDiagnostics(value.diagnostics);
  return {
    ...(value.artifacts ? { artifacts: value.artifacts } : {}),
    ...(value.cleanup ? { cleanup: value.cleanup } : {}),
    ...(redactCursorSettingEvidence(value.cursorSettings) ? { cursorSettings: redactCursorSettingEvidence(value.cursorSettings) } : {}),
    ...(value.failure ? { failure: safeText(value.failure) } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    model: value.model,
    provider: value.provider,
    runId: value.runId,
    steps: Array.isArray(value.steps)
      ? value.steps.map((stepValue) => ({
        name: safeText(stepValue.name),
        passed: stepValue.passed === true,
        ...(typeof stepValue.timestamp === "string" ? { timestamp: stepValue.timestamp } : {}),
      }))
      : [],
    ...(isSafeId(value.threadId) ? { threadId: value.threadId } : {}),
    ...(value.timestamps ? { timestamps: value.timestamps } : {}),
    ...(isSafeId(value.workspaceId) ? { workspaceId: value.workspaceId } : {}),
  };
}

function redactJourneyDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value)
    .filter(([key]) => ["rootAdmission", "rootCompletion", "stop", "continue", "cleanupStop"].includes(key))
    .map(([key, observation]) => [key, redactJourneyObservation(observation)])
    .filter(([, observation]) => observation !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function redactJourneyObservation(value) {
  if (!value || typeof value !== "object") return null;
  const durable = redactDurablePromptDiagnostics(value.durable);
  const queue = redactQueueDiagnostics(value);
  const state = redactJourneyState(value);
  if (!durable || !queue || !state) return null;
  return {
    durable,
    ...queue,
    ...state,
    ...(redactProviderEventDiagnostics(value.providerEvents) ? { providerEvents: redactProviderEventDiagnostics(value.providerEvents) } : {}),
  };
}

function redactProviderEventDiagnostics(value) {
  if (!value || !queueEventBooleanFieldsValid(value)) return null;
  if (![
    value.aStartEventCount,
    value.bStartEventCount,
    value.rootStartEventCount,
    value.terminalEventCount,
    value.turnStartedEventCount,
  ].every(isSafeDiagnosticCount)) return null;
  return {
    aStartEventCount: value.aStartEventCount,
    aStartedAfterRootTerminal: value.aStartedAfterRootTerminal,
    bStartEventCount: value.bStartEventCount,
    bStartedAfterContinue: value.bStartedAfterContinue,
    providerTerminalObserved: value.providerTerminalObserved,
    rootStartEventCount: value.rootStartEventCount,
    rootStarted: value.rootStarted,
    rootTerminalObserved: value.rootTerminalObserved,
    subscribed: value.subscribed,
    subscribedBeforeRoot: value.subscribedBeforeRoot,
    terminalEventCount: value.terminalEventCount,
    turnStartedEventCount: value.turnStartedEventCount,
    ...(isSafeDiagnosticCount(value.cursorRootTerminalSequenceCount)
      && typeof value.cursorRootTerminalObserved === "boolean"
      ? {
        cursorRootTerminalObserved: value.cursorRootTerminalObserved,
        cursorRootTerminalSequenceCount: value.cursorRootTerminalSequenceCount,
      }
      : {}),
  };
}

function redactCursorSettingEvidence(value) {
  if (!value || value.originalEnabled !== false || typeof value.restoredBeforeCleanup !== "boolean") return null;
  return { originalEnabled: false, restoredBeforeCleanup: value.restoredBeforeCleanup };
}

function queueEventBooleanFieldsValid(value) {
  return [
    "aStartedAfterRootTerminal",
    "bStartedAfterContinue",
    "providerTerminalObserved",
    "rootStarted",
    "rootTerminalObserved",
    "subscribed",
    "subscribedBeforeRoot",
  ].every((key) => typeof value[key] === "boolean");
}

function redactDurablePromptDiagnostics(value) {
  const counts = value?.exactPromptCounts;
  if (!counts || Object.keys(counts).sort().join(",") !== "A,B,C,root") return null;
  const safeCounts = [counts.root, counts.A, counts.B, counts.C, value.unexpectedUserMessageCount, value.userMessageCount];
  if (!safeCounts.every(isSafeDiagnosticCount)) return null;
  return {
    exactPromptCounts: { A: counts.A, B: counts.B, C: counts.C, root: counts.root },
    unexpectedUserMessageCount: value.unexpectedUserMessageCount,
    userMessageCount: value.userMessageCount,
  };
}

function redactQueueDiagnostics(value) {
  if (!isSafeDiagnosticCount(value.queueRowCount) || typeof value.queueMatchesExpected !== "boolean") return null;
  return { queueMatchesExpected: value.queueMatchesExpected, queueRowCount: value.queueRowCount };
}

function redactJourneyState(value) {
  if (typeof value.running === "boolean") return { running: value.running };
  if (typeof value.continueVisible === "boolean") return { continueVisible: value.continueVisible };
  return null;
}

function isSafeDiagnosticCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000;
}

/** Polls a condition until one explicit deadline, with no unbounded provider wait. */
export async function waitForBounded(condition, until, message) {
  while (Date.now() < until) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(message);
}

function providerArtifacts(evidenceDirectory, providerRunId) {
  return {
    afterContinue: evidenceFile(evidenceDirectory, `${providerRunId}-after-continue.png`),
    afterRoot: evidenceFile(evidenceDirectory, `${providerRunId}-after-root.png`),
    afterStop: evidenceFile(evidenceDirectory, `${providerRunId}-after-stop.png`),
    failure: evidenceFile(evidenceDirectory, `${providerRunId}-failure.png`),
    receipt: evidenceFile(evidenceDirectory, `${providerRunId}-receipt.json`),
  };
}

function compactArtifacts(repoRoot, artifacts) {
  return Object.fromEntries(Object.entries(artifacts)
    .filter(([name, path]) => name !== "failure" || NodeFS.existsSync(path))
    .filter(([name, path]) => name === "receipt" || NodeFS.existsSync(path))
    .map(([name, path]) => [name, relativePath(repoRoot, path)]));
}

export function rootPrompt(record) {
  return terminalWaitPrompt("root", record, ROOT_WAIT_MS);
}

export function queuePrompt(label, record) {
  return terminalWaitPrompt(label, record, QUEUE_WAIT_MS);
}

function terminalWaitPrompt(label, record, milliseconds) {
  return `${marker(label, record)} Run \`powershell -NoProfile -Command "Start-Sleep -Milliseconds ${milliseconds}"\`. Do not modify files. Return only this marker.`;
}

function marker(label, record) {
  return `CQ-${label}-${record.marker}`;
}

function step(name) {
  return { name, passed: true, timestamp: new Date().toISOString() };
}

function deadline() {
  return Date.now() + LIVE_TIMEOUT_MS;
}

function runId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${NodeCrypto.randomUUID()}`;
}

function ensureEvidenceDirectory(repoRoot) {
  return resolveEvidenceDirectory(repoRoot, true);
}

export function resolveEvidenceDirectory(repoRoot, create) {
  const paths = getRuntimePaths(repoRoot);
  const directory = NodePath.resolve(repoRoot, EVIDENCE_DIRECTORY);
  assertInsideDevDir(directory, paths.devDir);
  assertExistingEvidenceComponents(paths.devDir, directory);
  if (!create && !NodeFS.existsSync(directory)) return directory;
  createNormalDirectory(NodePath.join(paths.devDir, "verification"));
  createNormalDirectory(directory);
  createNormalDirectory(NodePath.join(directory, "receipts"));
  assertEvidenceDirectories(paths.devDir, directory);
  return directory;
}

export function evidenceFile(evidenceDirectory, fileName) {
  if (typeof fileName !== "string" || !/^[A-Za-z0-9._-]{1,512}$/.test(fileName)) {
    throw new Error("Composer queue evidence file name is invalid");
  }
  const receipts = NodePath.resolve(evidenceDirectory, "receipts");
  const path = NodePath.resolve(receipts, fileName);
  if (NodePath.dirname(path) !== receipts) throw new Error("Composer queue evidence file escaped receipts");
  assertInsideDevDir(path, getRuntimePaths(resolveRepoRoot()).devDir);
  assertEvidenceDirectories(getRuntimePaths(resolveRepoRoot()).devDir, evidenceDirectory);
  return path;
}

function assertEvidenceDirectories(devDirectory, evidenceDirectory) {
  const verificationDirectory = NodePath.join(devDirectory, "verification");
  const receiptsDirectory = NodePath.join(evidenceDirectory, "receipts");
  for (const path of [devDirectory, verificationDirectory, evidenceDirectory, receiptsDirectory]) {
    if (!NodeFS.existsSync(path) || NodeFS.lstatSync(path).isSymbolicLink()) {
      throw new Error("Composer queue evidence path is linked or unavailable");
    }
  }
}

function assertExistingEvidenceComponents(devDirectory, evidenceDirectory) {
  const verificationDirectory = NodePath.join(devDirectory, "verification");
  const receiptsDirectory = NodePath.join(evidenceDirectory, "receipts");
  for (const path of [devDirectory, verificationDirectory, evidenceDirectory, receiptsDirectory]) {
    if (!NodeFS.existsSync(path)) continue;
    const stat = NodeFS.lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Composer queue evidence path is linked or unavailable");
    }
  }
}

function createNormalDirectory(path) {
  if (NodeFS.existsSync(path)) return;
  NodeFS.mkdirSync(path);
  const stat = NodeFS.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Composer queue evidence path is linked or unavailable");
  }
}

function activeRunPath(evidenceDirectory) {
  return NodePath.join(evidenceDirectory, "active-run.json");
}

export function writeActiveRun(evidenceDirectory, record) {
  assertActiveRecord(evidenceDirectory, record);
  assertEvidenceDirectories(getRuntimePaths(resolveRepoRoot()).devDir, evidenceDirectory);
  const path = activeRunPath(evidenceDirectory);
  const existing = readActiveRun(evidenceDirectory);
  if (existing && existing.id !== record.id) {
    throw new Error("An interrupted Composer queue proof is still active. Run cleanup before replacing its recovery record.");
  }
  if (existing) return replaceOwnedActiveRun(evidenceDirectory, record);
  try {
    const descriptor = NodeFS.openSync(path, "wx", 0o600);
    try {
      NodeFS.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      NodeFS.closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const winner = readActiveRun(evidenceDirectory);
    if (winner?.id !== record.id) {
      throw new Error("An interrupted Composer queue proof is still active. Run cleanup before replacing its recovery record.");
    }
    return replaceOwnedActiveRun(evidenceDirectory, record);
  }
}

function replaceOwnedActiveRun(evidenceDirectory, record) {
  const active = readActiveRun(evidenceDirectory);
  if (!active || active.id !== record.id) {
    throw new Error("Composer queue active run belongs to a different run");
  }
  const path = activeRunPath(evidenceDirectory);
  const temporaryPath = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    NodeFS.renameSync(temporaryPath, path);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

function readActiveRun(evidenceDirectory) {
  const path = activeRunPath(evidenceDirectory);
  if (!NodeFS.existsSync(path)) return null;
  if (NodeFS.lstatSync(path).isSymbolicLink()) throw new Error("Composer queue active run is linked");
  const record = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  return assertActiveRecord(evidenceDirectory, record);
}

export function removeActiveRun(evidenceDirectory, expectedRunId) {
  if (!isSafeId(expectedRunId) && !RUN_ID_PATTERN.test(expectedRunId?.replace(/-(?:codex|cursor|navigation)$/, "") ?? "")) {
    return "Composer queue cleanup has no valid active run ID";
  }
  try {
    const path = activeRunPath(evidenceDirectory);
    if (!NodeFS.existsSync(path)) return "Composer queue active run is missing during cleanup";
    const active = readActiveRun(evidenceDirectory);
    if (active.id !== expectedRunId) return "Composer queue active run belongs to a different run";
    NodeFS.unlinkSync(path);
    return null;
  } catch (error) {
    return safeError(error);
  }
}

function assertActiveRecord(evidenceDirectory, record) {
  requireActiveRecordObject(record);
  requireActiveRecordShape(record);
  requireActiveRecordIdentity(record);
  requireActiveRecordOwnership(record);
  assertInsideDevDir(evidenceDirectory, getRuntimePaths(resolveRepoRoot()).devDir);
  return record;
}

function requireActiveRecordObject(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Composer queue active run is invalid");
  }
}

function requireActiveRecordShape(record) {
  const keys = ["cursorEnabledByVerifier", "cursorOriginalEnabled", "cursorRestorePending", "electronRuntimeDirectory", "id", "marker", "model", "ownsWorkspace", "provider", "sessionFileName", "threadId", "workspaceCreationPending", "workspaceId"];
  if (Object.keys(record).sort().join(",") !== keys.join(",")) {
    throw new Error("Composer queue active run has an unexpected shape");
  }
}

function requireActiveRecordIdentity(record) {
  const runId = record.id.replace(/-(?:codex|cursor|navigation)$/, "");
  if (!RUN_ID_PATTERN.test(runId) || !ACTIVE_RUN_PROVIDERS.includes(record.provider)) {
    throw new Error("Composer queue active run has an invalid provider or run ID");
  }
  if (!SAFE_MODEL_PATTERN.test(record.model) || !/^[a-f0-9]{8}$/i.test(record.marker) || !SESSION_FILE_PATTERN.test(record.sessionFileName)) {
    throw new Error("Composer queue active run has invalid ownership fields");
  }
  if (!record.sessionFileName.startsWith(`electron-composer-queue-${record.provider}-`)) {
    throw new Error("Composer queue active run has an invalid Electron session owner");
  }
  if (record.provider === "navigation" && record.model !== "navigation") {
    throw new Error("Composer queue navigation recovery has an invalid model marker");
  }
}

function requireActiveRecordOwnership(record) {
  requireCursorRestoreState(record);
  requireNullableString(record.electronRuntimeDirectory, "Electron runtime directory");
  requireNullableSafeId(record.threadId, "thread ID");
  requireNullableSafeId(record.workspaceId, "workspace ID");
  requireWorkspaceOwnershipFlags(record);
  if (record.workspaceCreationPending && (record.workspaceId !== null || record.ownsWorkspace)) {
    throw new Error("Composer queue active run has inconsistent workspace ownership");
  }
}

function requireCursorRestoreState(record) {
  if (typeof record.cursorEnabledByVerifier !== "boolean") {
    throw new Error("Composer queue active run has an invalid Cursor enablement flag");
  }
  if (record.cursorOriginalEnabled !== null && typeof record.cursorOriginalEnabled !== "boolean") {
    throw new Error("Composer queue active run has an invalid Cursor original state");
  }
  if (typeof record.cursorRestorePending !== "boolean") {
    throw new Error("Composer queue active run has an invalid Cursor restoration flag");
  }
  if (record.cursorRestorePending && record.cursorOriginalEnabled !== false) {
    throw new Error("Composer queue active run has inconsistent Cursor restoration state");
  }
  if (record.cursorEnabledByVerifier && record.cursorOriginalEnabled !== false) {
    throw new Error("Composer queue active run has inconsistent Cursor enablement state");
  }
}

function requireNullableString(value, field) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`Composer queue active run has an invalid ${field}`);
  }
}

function requireNullableSafeId(value, field) {
  if (value !== null && !isSafeId(value)) throw new Error(`Composer queue active run has an invalid ${field}`);
}

function requireWorkspaceOwnershipFlags(record) {
  if (typeof record.ownsWorkspace !== "boolean") {
    throw new Error("Composer queue active run has an invalid workspace ownership flag");
  }
  if (typeof record.workspaceCreationPending !== "boolean") {
    throw new Error("Composer queue active run has an invalid workspace creation flag");
  }
}

export function listKnownReceipts(repoRoot, evidenceDirectory) {
  const directory = NodePath.join(evidenceDirectory, "receipts");
  if (!NodeFS.existsSync(directory) || NodeFS.lstatSync(directory).isSymbolicLink()) return [];
  return NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /(?:-(?:codex|cursor)-(?:receipt\.json|after-(?:root|stop|continue)\.png|failure\.png)|-navigation-repro-receipt\.json|-matrix\.json)$/.test(entry.name))
    .map((entry) => relativePath(repoRoot, NodePath.join(directory, entry.name)))
    .sort();
}

function writeEvidenceJson(path, value) {
  const evidenceDirectory = NodePath.dirname(NodePath.dirname(path));
  if (NodePath.basename(path) === "active-run.json") {
    assertEvidenceDirectories(getRuntimePaths(resolveRepoRoot()).devDir, NodePath.dirname(path));
  } else {
    evidenceFile(evidenceDirectory, NodePath.basename(path));
  }
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function electronSessionPath(repoRoot, sessionFileName) {
  return NodePath.join(getRuntimePaths(repoRoot).devDir, sessionFileName);
}

function pathsMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (path) => NodePath.resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  const first = normalize(left);
  const second = normalize(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function relativePath(repoRoot, path) {
  return NodePath.relative(repoRoot, path).replace(/\\/g, "/");
}

function cliError(message) {
  return actionable(message, "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue --help.");
}

function actionable(message, nextAction) {
  return new Error(`Condition: ${safeText(message)}. Next action: ${safeText(nextAction)}`);
}

function safeError(error) {
  return safeText(error instanceof Error ? error.message : String(error));
}

function safeText(value) {
  return String(value).replace(/[\r\n\t]+/g, " ").slice(0, 640);
}

if (import.meta.main) await main();
