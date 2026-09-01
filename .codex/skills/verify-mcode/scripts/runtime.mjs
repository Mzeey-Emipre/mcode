#!/usr/bin/env bun
/** Verify the public AgentService runtime contract without exposing runtime credentials. */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import {
  assertInsideDevDir,
  getRuntimePaths,
  readPortsFile,
  resolveRepoRoot,
} from "../../../../scripts/agent/runtime-contract.mjs";

const HEALTH_TIMEOUT_MS = 15_000;
const LIVE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const FRESHNESS_TOLERANCE_MS = 2_000;
const MAX_ERROR_CHARS = 640;
const EVIDENCE_DIRECTORY = NodePath.join(".dev", "verification", "agent-runtime");
const RUNTIME_SOURCE_DIRECTORIES = [
  ["apps", "server", "src"],
  ["packages", "contracts", "src"],
  ["packages", "providers", "src"],
  ["packages", "shared", "src"],
];
const PROVIDERS = new Set(["codex", "claude", "cursor"]);
const SCENARIOS = new Set(["completion", "stop"]);
const FOCUSED_TEST_FILES = [
  "src/features/agents/composition/__tests__/agent-service-container.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-child-stop.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-existing-worktree.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-gate.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-goal-command.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-goal-lookup.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-narrative-persist.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-plan-marker.test.ts",
  "src/features/agents/orchestration/__tests__/provider-agent-error-normalize.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-session-invalidated.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-transient-retry.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-turn-cleanup.test.ts",
  "src/features/agents/orchestration/__tests__/agent-service-turn-started.test.ts",
  "src/features/agents/transport/__tests__/agent-rpc-route.test.ts",
  "src/features/agents/transport/__tests__/agent-list-running-rpc.test.ts",
  "src/features/agents/turns/__tests__/turn-event-pipeline.test.ts",
  "src/features/agents/turns/__tests__/turn-event-sink.test.ts",
  "src/features/agents/turns/__tests__/turn-finalizer.test.ts",
  "src/features/agents/turns/__tests__/turn-runtime.test.ts",
  "src/features/providers/composition/__tests__/provider-event-ingress.test.ts",
];
const FIXED_PROMPTS = {
  completion: "Reply with exactly: Agent runtime verification complete. Do not edit files or invoke tools.",
  stop: "Inspect this repository with read-only file-search and file-reading tools. Do not write files, change settings, or run mutating commands. Explain the repository structure in detail.",
};

const HELP = `Verify Mcode runtime

Usage:
  bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime <command> [options]

Commands:
  health
      Validate this worktree's .dev/ports.json and GET /health. Does not start a runtime.
  check
      Run focused AgentService/event tests, bun run verify:changed, and bun run lint:fast.
  inspect
      Read active runtime and workspace summaries through the authenticated WebSocket RPC API.
  live --provider <codex|claude|cursor> --model <id> --scenario <completion|stop> --confirm-provider-call [--keep-thread]
      Make one confirmed provider call in the registered current-worktree workspace. Does not start a runtime.
  diagnostics
      Summarize harness receipt metadata without emitting raw contents.
  cleanup
      Remove only harness-created receipts, timelines, and check logs. It does not stop a runtime or reset a database.

Timeouts:
  Health: 15 seconds, from scripts/dev-web.mjs.
  Live: 120 seconds, from scripts/providers/codex/codex-live-verify.mjs.

Live limitation:
  The public subscription RPC requires a thread ID, but agent.createAndSend creates that ID.
  The harness requests retained agent-event replay with cursor 0 immediately after creation. It cannot prove a pre-create subscription until the public contract adds a caller-supplied thread ID or workspace subscription.

Stop proof:
  The stop scenario requires agent.activeCount to reach 0 and agent.listRunning to retain the matching cancelled snapshot for reconnect hydration.`;

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  const repoRoot = resolveRepoRoot();
  const result = await execute(parsed, repoRoot);
  printJson(result.output);
  return result.exitCode;
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...rest] = argv;
  validateCommand(command);
  return command === "live" ? parseLiveArguments(rest) : parseOptionlessCommand(command, rest);
}

function validateCommand(command) {
  if (["health", "check", "inspect", "live", "diagnostics", "cleanup"].includes(command)) return;
  throw cliError(`Unknown command "${String(command)}"`);
}

function parseOptionlessCommand(command, rest) {
  if (rest.length > 0) throw cliError(`${command} does not accept options`);
  return { command };
}

function parseLiveArguments(rest) {
  const options = readLiveOptions(rest);
  const provider = options.get("--provider");
  const model = options.get("--model");
  const scenario = options.get("--scenario");
  validateLiveOptions(options, provider, model, scenario);
  return { command: "live", provider, model, scenario, keepThread: options.has("--keep-thread") };
}

function readLiveOptions(rest) {
  const options = new Map();
  let index = 0;
  while (index < rest.length) {
    index = readLiveOption(rest, index, options);
  }
  return options;
}

function readLiveOption(rest, index, options) {
  const option = rest[index];
  if (["--confirm-provider-call", "--keep-thread"].includes(option)) {
    setLiveOption(options, option, true);
    return index + 1;
  }
  if (!["--provider", "--model", "--scenario"].includes(option)) throw cliError(`Unknown option ${String(option)}`);
  const value = rest[index + 1];
  if (!value || value.startsWith("--")) throw cliError(`Missing value for ${option}`);
  setLiveOption(options, option, value);
  return index + 2;
}

function setLiveOption(options, option, value) {
  if (options.has(option)) throw cliError(`Duplicate option ${option}`);
  options.set(option, value);
}

function validateLiveOptions(options, provider, model, scenario) {
  if (!PROVIDERS.has(provider)) throw cliError("--provider must be codex, claude, or cursor");
  if (typeof model !== "string" || !/^[^\s]{1,256}$/.test(model)) throw cliError("--model must be a non-empty ID of at most 256 non-space characters");
  if (!SCENARIOS.has(scenario)) throw cliError("--scenario must be completion or stop");
  if (options.has("--confirm-provider-call")) return;
  throw actionable("Provider confirmation is missing", "Add --confirm-provider-call after you choose an available provider and model.");
}

async function execute(parsed, repoRoot) {
  try {
    if (parsed.command === "health") return success(await health(repoRoot));
    if (parsed.command === "check") return await check(repoRoot);
    if (parsed.command === "inspect") return success(await inspect(repoRoot));
    if (parsed.command === "live") return await live(repoRoot, parsed);
    if (parsed.command === "diagnostics") return success(diagnostics(repoRoot));
    return success(cleanup(repoRoot));
  } catch (error) {
    return failure(parsed.command, error);
  }
}

function success(output) {
  return { exitCode: 0, output: { ok: true, ...output } };
}

function failure(command, error) {
  return {
    exitCode: 1,
    output: { ok: false, command, error: safeError(error) },
  };
}

function readRuntime(repoRoot) {
  try {
    const ports = readPortsFile(repoRoot);
    if (!ports) {
      throw actionable("The runtime contract is missing", "Run bun run --shell system agent:up in this worktree.");
    }
    return ports;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Condition:")) throw error;
    throw actionable("The runtime contract is invalid", "Run bun run --shell system agent:down, then bun run --shell system agent:up in this worktree.");
  }
}

function resolveOptionalBranch(repoRoot) {
  try {
    const branch = NodeChildProcess.execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return branch || undefined;
  } catch {
    throw actionable("The current Git branch could not be resolved", "Run git status in this worktree, then retry live verification.");
  }
}

function assertRuntimeFreshness(repoRoot) {
  const artifacts = runtimeArtifacts(repoRoot);
  const staleSources = runtimeSourceFiles(repoRoot).filter((source) => sourceIsNewerThanArtifact(source, artifacts.bundle)
    || sourceIsNewerThanArtifact(source, artifacts.ports));
  if (staleSources.length === 0) return;
  throw staleRuntimeError(repoRoot, staleSources, artifacts);
}

function runtimeArtifacts(repoRoot) {
  const runtimePaths = getRuntimePaths(repoRoot);
  return {
    bundle: requiredFileTimestamp(NodePath.join(repoRoot, "apps", "desktop", "dist", "server", "server.cjs"), "runtime server bundle"),
    ports: requiredFileTimestamp(runtimePaths.portsFile, "runtime ports contract"),
  };
}

function requiredFileTimestamp(path, label) {
  if (!NodeFS.existsSync(path) || !NodeFS.statSync(path).isFile()) {
    throw actionable(`The ${label} is missing: ${relativeTo(resolveRepoRoot(), path)}`, "Run bun run --shell system agent:down, then bun run --shell system agent:up in this worktree.");
  }
  return { path, modifiedMs: NodeFS.statSync(path).mtimeMs };
}

function runtimeSourceFiles(repoRoot) {
  return RUNTIME_SOURCE_DIRECTORIES.flatMap((parts) => runtimeSourceFilesUnder(NodePath.join(repoRoot, ...parts)));
}

function runtimeSourceFilesUnder(directory) {
  if (!NodeFS.existsSync(directory)) return [];
  const files = [];
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const candidate = NodePath.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "__tests__") files.push(...runtimeSourceFilesUnder(candidate));
    if (entry.isFile() && !isTestSourceFile(entry.name)) files.push({ path: candidate, modifiedMs: NodeFS.statSync(candidate).mtimeMs });
  }
  return files;
}

function isTestSourceFile(name) {
  return /\.(?:test|spec)\.[^.]+$/i.test(name);
}

function sourceIsNewerThanArtifact(source, artifact) {
  return source.modifiedMs > artifact.modifiedMs + FRESHNESS_TOLERANCE_MS;
}

function staleRuntimeError(repoRoot, staleSources, artifacts) {
  const paths = staleSources.slice(0, 3).map((source) => relativeTo(repoRoot, source.path)).join(", ");
  const artifactPaths = [relativeTo(repoRoot, artifacts.bundle.path), relativeTo(repoRoot, artifacts.ports.path)].join(", ");
  return actionable(`${staleSources.length} runtime source file(s) are newer than ${artifactPaths}: ${paths}`, "Run bun run --shell system agent:down, then bun run --shell system agent:up in this worktree.");
}

async function health(repoRoot) {
  assertRuntimeFreshness(repoRoot);
  const ports = readRuntime(repoRoot);
  let response;
  try {
    response = await fetch(ports.healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch {
    throw actionable("The health request did not complete within 15 seconds", "Run bun run --shell system agent:up in this worktree, then retry health.");
  }
  if (!response.ok) {
    throw actionable(`/health returned HTTP ${response.status}`, "Run bun run --shell system agent:up in this worktree, then retry health.");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw actionable("/health returned invalid JSON", "Restart this worktree runtime with bun run --shell system agent:down and bun run --shell system agent:up.");
  }
  if (!payload || payload.status !== "ok" || !Number.isInteger(payload.activeAgents) || payload.activeAgents < 0) {
    throw actionable("/health did not return status=ok with a non-negative activeAgents count", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then restart this worktree runtime.");
  }
  if (!pathsMatch(ports.worktreeIdentity, repoRoot)) {
    throw actionable("The runtime worktree identity does not match this repository", "Run bun run --shell system agent:down in the mismatched worktree, then start this worktree with bun run --shell system agent:up.");
  }
  return {
    command: "health",
    runtime: {
      healthUrl: ports.healthUrl,
      appUrl: ports.appUrl,
      worktreeIdentity: ports.worktreeIdentity,
      serverPort: ports.serverPort,
      webPort: ports.webPort,
      worktreeIdentityMatchesRepo: pathsMatch(ports.worktreeIdentity, repoRoot),
      status: payload.status,
      activeAgents: payload.activeAgents,
    },
  };
}

async function inspect(repoRoot) {
  const healthResult = await health(repoRoot);
  const ports = readRuntime(repoRoot);
  const socket = await openSocket(repoRoot, ports);
  try {
    const [activeCount, running, workspaces] = await Promise.all([
      socket.rpc("agent.activeCount", {}),
      socket.rpc("agent.listRunning", {}),
      socket.rpc("workspace.list", {}),
    ]);
    if (!Array.isArray(running) || !Array.isArray(workspaces) || !Number.isInteger(activeCount) || activeCount < 0) {
      throw actionable("Runtime RPC returned an unexpected active-agent, running-turn, or workspace summary", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry inspect.");
    }
    const currentWorktreeRegistered = workspaces.some((workspace) => workspace && pathsMatch(workspace.path, repoRoot));
    if (!currentWorktreeRegistered) {
      throw actionable("workspace.list does not contain the current repository path", "Register this repository as a workspace in Mcode, then retry inspect.");
    }
    return {
      command: "inspect",
      runtime: {
        ...healthResult.runtime,
        activeCount,
        running: running.slice(0, 50).map(redactRuntimeSnapshot),
        runningTruncated: running.length > 50,
      },
      workspaces: {
        count: workspaces.length,
        currentWorktreeRegistered,
      },
    };
  } finally {
    await socket.close();
  }
}

async function check(repoRoot) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  const stamp = fileStamp();
  const phases = [
    { name: "focused-agent-runtime", args: ["--cwd", "apps/server", "run", "test", "--", ...FOCUSED_TEST_FILES] },
    { name: "verify-changed", args: ["run", "verify:changed"] },
    { name: "lint-fast", args: ["run", "lint:fast"] },
  ];
  const results = [];
  for (const phase of phases) {
    const logPath = NodePath.join(evidenceDirectory, `${stamp}-${phase.name}.log`);
    const result = await runBun(repoRoot, phase.args, logPath);
    results.push({ name: phase.name, exitCode: result.exitCode, logPath: relativeTo(repoRoot, logPath), decisiveFailure: result.failure });
  }
  const failed = results.find((result) => result.exitCode !== 0);
  return {
    exitCode: failed?.exitCode ?? 0,
    output: {
      ok: !failed,
      command: "check",
      phases: results,
      firstDecisiveFailure: failed?.decisiveFailure ?? null,
    },
  };
}

async function runBun(repoRoot, args, logPath) {
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  try {
    const child = Bun.spawn({
      cmd: ["bun", ...args],
      cwd: repoRoot,
      env: childCommandEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  } catch (error) {
    stderr = safeError(error);
  }
  NodeFS.writeFileSync(logPath, `${stdout}${stderr}`, "utf8");
  return { exitCode: Number.isInteger(exitCode) ? exitCode : 1, failure: exitCode === 0 ? null : firstFailure(stdout, stderr) };
}

function childCommandEnvironment() {
  const environment = { ...process.env };
  delete environment.MCODE_BROWSER_MCP_TOKEN;
  return environment;
}

async function live(repoRoot, options) {
  const artifacts = createLiveArtifacts(repoRoot, options);
  const run = { report: createLiveReport(options), socket: null, threadId: null, proofDeadline: null };
  try {
    await prepareLiveRun(repoRoot, options, run);
    await proveLiveScenario(options.scenario, run);
  } catch (error) {
    run.report.failure = safeError(error);
  } finally {
    await disposeLiveRun(run, options.keepThread);
  }
  return writeLiveArtifacts(repoRoot, artifacts, run.report);
}

function createLiveArtifacts(repoRoot, options) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  const stamp = fileStamp();
  return {
    receiptPath: NodePath.join(evidenceDirectory, `${stamp}-${options.scenario}-receipt.json`),
    timelinePath: NodePath.join(evidenceDirectory, `${stamp}-${options.scenario}-timeline.html`),
  };
}

function createLiveReport(options) {
  return {
    command: "live",
    provider: options.provider,
    model: options.model,
    scenario: options.scenario,
    subscription: null,
    coverageGap: "The public API cannot subscribe to an unknown thread before agent.createAndSend creates it.",
    terminalEvent: null,
    conversationAssistant: false,
    messageAssistant: false,
    stopResults: [],
    sharedStopResult: null,
    activeCountCleared: false,
    cancelledSnapshotRetained: false,
    cleanup: { attempted: false, deleted: null, retained: options.keepThread },
    events: [],
    failure: null,
  };
}

async function prepareLiveRun(repoRoot, options, run) {
  await health(repoRoot);
  run.socket = await openSocket(repoRoot, readRuntime(repoRoot), (push) => recordPush(run, push));
  const workspace = await findCurrentWorkspace(run.socket, repoRoot);
  run.proofDeadline = Date.now() + LIVE_TIMEOUT_MS;
  run.threadId = await createLiveThread(run.socket, workspace, repoRoot, options, run.proofDeadline);
  run.report.thread = fingerprint(run.threadId);
  const subscription = await subscribeToLiveThread(run.socket, run.threadId, run.proofDeadline);
  run.report.subscription = subscription;
  if (subscription.hydrationRequired) {
    throw actionable("The retained event journal requires hydration for the created thread", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime inspect, then retry live verification after hydration is available.");
  }
}

async function findCurrentWorkspace(socket, repoRoot) {
  const workspaces = await socket.rpc("workspace.list", {});
  if (!Array.isArray(workspaces)) {
    throw actionable("workspace.list returned an unexpected value", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime inspect, then retry live verification.");
  }
  const workspace = workspaces.find((candidate) => candidate && pathsMatch(candidate.path, repoRoot));
  if (workspace) return workspace;
  throw actionable("The current worktree is not registered as a workspace", "Add this repository in Mcode, then retry live verification.");
}

async function createLiveThread(socket, workspace, repoRoot, options, deadline) {
  const created = await socket.rpc("agent.createAndSend", {
    workspaceId: workspace.id,
    content: FIXED_PROMPTS[options.scenario],
    model: options.model,
    provider: options.provider,
    mode: "direct",
    branch: resolveOptionalBranch(repoRoot),
    permissionMode: "full",
  }, deadline);
  if (typeof created?.id === "string" && created.id.length > 0) return created.id;
  throw actionable("agent.createAndSend did not return a thread ID", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the server response.");
}

async function subscribeToLiveThread(socket, threadId, deadline) {
  const subscription = await socket.rpc("push.setThreadSubscriptions", {
    threadIds: [threadId],
    cursors: { [threadId]: 0 },
  }, deadline);
  return summarizeSubscription(subscription, threadId);
}

async function proveLiveScenario(scenario, run) {
  if (scenario === "completion") return proveCompletion(run);
  return proveStop(run);
}

async function proveCompletion(run) {
  await requireTerminalEvent(run.report, run.proofDeadline);
  await requireDurableAssistant(run.socket, run.threadId, run.report, run.proofDeadline);
}

async function requireTerminalEvent(report, deadline) {
  const outcome = await waitFor(() => findCompletionOutcome(report.events), deadline);
  if (!outcome) {
    throw actionable("No terminal provider event arrived before the 120-second live deadline", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry with an available model.");
  }
  if (!outcome.succeeded) {
    throw actionable(`The target thread ended with ${outcome.label} before successful completion`, "Inspect the redacted receipt and provider availability, then retry with an available model.");
  }
  report.terminalEvent = outcome.label;
}

function findCompletionOutcome(events) {
  for (const event of events) {
    if (event.kind === "agent" && ["turnComplete", "ended"].includes(event.type)) {
      return { succeeded: true, label: event.type };
    }
    if (event.kind === "agent" && event.type === "error") return { succeeded: false, label: "error" };
    if (event.kind === "status" && ["errored", "cancelled", "interrupted", "paused"].includes(event.status)) {
      return { succeeded: false, label: event.status };
    }
  }
  return null;
}

async function requireDurableAssistant(socket, threadId, report, deadline) {
  const durable = await waitForAsync(async () => {
    const [page, messages] = await Promise.all([
      socket.rpc("conversation.page", { threadId, limit: 100 }, deadline),
      socket.rpc("message.list", { threadId, limit: 100 }, deadline),
    ]);
    report.conversationAssistant ||= hasDurableAssistant(page);
    report.messageAssistant ||= hasDurableAssistant(messages);
    return report.conversationAssistant && report.messageAssistant;
  }, deadline);
  if (durable) return;
  throw actionable("Durable assistant data did not appear through both conversation.page and message.list before the 120-second live deadline", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry completion.");
}

async function proveStop(run) {
  await requireTurnStarted(run.report, run.proofDeadline);
  run.report.stopResults = await Promise.all([
    run.socket.rpc("agent.stop", { threadId: run.threadId }, run.proofDeadline),
    run.socket.rpc("agent.stop", { threadId: run.threadId }, run.proofDeadline),
  ]);
  run.report.sharedStopResult = hasSharedStopResult(run.report.stopResults, run.threadId);
  if (!run.report.sharedStopResult) {
    throw actionable("Concurrent agent.stop calls did not return one shared cancelled outcome", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry stop verification.");
  }
  await requireStoppedOutcome(run.report, run.proofDeadline);
  await requireCancelledRuntimeState(run.socket, run.threadId, run.report, run.proofDeadline);
}

async function requireTurnStarted(report, deadline) {
  const started = await waitFor(() => report.events.some((event) => event.kind === "agent" && event.type === "turnStarted"), deadline);
  if (started) return;
  throw actionable("No turnStarted event arrived before the 120-second live deadline", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry stop verification.");
}

async function requireStoppedOutcome(report, deadline) {
  const stopped = await waitFor(() => hasStoppedStatus(report.events), deadline);
  if (stopped) return;
  throw actionable("Concurrent agent.stop calls did not produce a cancelled, interrupted, or paused outcome", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry stop verification.");
}

function hasStoppedStatus(events) {
  return events.some((event) => event.kind === "status" && ["paused", "interrupted", "cancelled"].includes(event.status));
}

function hasSharedStopResult(stopResults, threadId) {
  if (!Array.isArray(stopResults) || stopResults.length !== 2) return false;
  const [first, second] = stopResults;
  return isCancelledStopResult(first, threadId)
    && isCancelledStopResult(second, threadId)
    && sharedStopMetadata(first, second, threadId);
}

function isCancelledStopResult(result, threadId) {
  return result?.status === "cancelled"
    && result.threadId === threadId
    && typeof result.turnExecutionId === "string"
    && result.turnExecutionId.length > 0
    && result.snapshot?.phase === "cancelled"
    && result.snapshot.turnExecutionId === result.turnExecutionId;
}

function sharedStopMetadata(first, second, threadId) {
  return first.turnExecutionId === second.turnExecutionId
    && first.dispatchState === second.dispatchState
    && snapshotsMatch(first.snapshot, second.snapshot)
    && first.snapshot.threadId === threadId;
}

function snapshotsMatch(first, second) {
  if (!first || !second) return false;
  return ["threadId", "turnExecutionId", "phase", "savingStatus"].every((key) => first[key] === second[key]);
}

async function requireCancelledRuntimeState(socket, threadId, report, deadline) {
  const turnExecutionId = report.stopResults[0].turnExecutionId;
  const verified = await waitForAsync(async () => {
    const [activeCount, snapshots] = await Promise.all([
      socket.rpc("agent.activeCount", {}, deadline),
      socket.rpc("agent.listRunning", {}, deadline),
    ]);
    const activeCountCleared = activeCount === 0;
    const cancelledSnapshotRetained = Array.isArray(snapshots) && snapshots.some((snapshot) => (
      snapshot?.threadId === threadId
      && snapshot.turnExecutionId === turnExecutionId
      && snapshot.phase === "cancelled"
    ));
    report.activeCountCleared ||= activeCountCleared;
    report.cancelledSnapshotRetained ||= cancelledSnapshotRetained;
    return activeCountCleared && cancelledSnapshotRetained;
  }, deadline);
  if (verified) return;
  throw actionable("The stopped turn did not clear agent.activeCount while retaining its matching cancelled snapshot before the 120-second live deadline", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect teardown and retry stop verification.");
}

async function disposeLiveRun(run, keepThread) {
  await deleteLiveThread(run, keepThread);
  if (run.socket) await run.socket.close();
}

async function deleteLiveThread(run, keepThread) {
  if (!run.threadId || !run.socket || keepThread) return;
  run.report.cleanup.attempted = true;
  try {
    const deleted = await run.socket.rpc("thread.delete", { threadId: run.threadId, cleanupWorktree: false });
    run.report.cleanup.deleted = deleted === true;
    if (deleted !== true) {
      run.report.cleanup.failure = safeError(actionable("thread.delete did not confirm deletion of the harness-created thread", "Inspect the retained thread in Mcode, then delete it before you retry live verification."));
    }
  } catch (error) {
    run.report.cleanup.deleted = false;
    run.report.cleanup.failure = safeError(error);
  }
}

function writeLiveArtifacts(repoRoot, artifacts, report) {
  const receipt = redactReceipt(report);
  NodeFS.writeFileSync(artifacts.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  NodeFS.writeFileSync(artifacts.timelinePath, renderTimeline(receipt), "utf8");
  const output = {
    ...receipt,
    receiptPath: relativeTo(repoRoot, artifacts.receiptPath),
    timelinePath: relativeTo(repoRoot, artifacts.timelinePath),
  };
  return { exitCode: receipt.ok ? 0 : 1, output };
}

function recordPush(run, push) {
  if (typeof run.threadId !== "string" || push?.data?.threadId !== run.threadId) return;
  if (push.channel === "agent.event" && typeof push.data.type === "string") {
    run.report.events.push({ kind: "agent", type: push.data.type, elapsedMs: Date.now() });
  }
  if (push.channel === "thread.status" && typeof push.data.status === "string") {
    run.report.events.push({ kind: "status", status: push.data.status, elapsedMs: Date.now() });
  }
  if (run.report.events.length > 400) run.report.events.splice(0, run.report.events.length - 400);
}

function hasDurableAssistant(value) {
  return Array.isArray(value?.messages)
    && value.messages.some((message) => message?.role === "assistant"
      && typeof message.content === "string"
      && message.content.trim().length > 0);
}

function summarizeSubscription(subscription, threadId) {
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) {
    throw actionable("push.setThreadSubscriptions returned an unexpected replay result", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry live verification.");
  }
  const hydrationRequiredThreadIds = Array.isArray(subscription.hydrationRequiredThreadIds)
    ? subscription.hydrationRequiredThreadIds
    : [];
  const replayedThrough = subscription.replayedThrough && typeof subscription.replayedThrough === "object"
    ? subscription.replayedThrough[threadId]
    : null;
  const canonicalRecoveries = Array.isArray(subscription.canonicalRecoveries)
    ? subscription.canonicalRecoveries.length
    : null;
  return {
    cursor: 0,
    hydrationRequired: hydrationRequiredThreadIds.includes(threadId),
    replayedThrough: Number.isInteger(replayedThrough) ? replayedThrough : null,
    canonicalRecoveryCount: canonicalRecoveries,
  };
}

function redactReceipt(report) {
  const startedAt = report.events[0]?.elapsedMs ?? null;
  return {
    ok: report.failure === null && report.cleanup.failure === undefined,
    command: report.command,
    provider: report.provider,
    model: report.model,
    scenario: report.scenario,
    thread: report.thread ?? null,
    subscription: report.subscription,
    coverageGap: report.coverageGap,
    terminalEvent: report.terminalEvent,
    conversationAssistant: report.conversationAssistant,
    messageAssistant: report.messageAssistant,
    stopResults: report.stopResults.map((result) => ({ status: result?.status ?? null, phase: result?.snapshot?.phase ?? null, dispatchState: result?.dispatchState ?? null })),
    sharedStopResult: report.sharedStopResult,
    activeCountCleared: report.activeCountCleared,
    cancelledSnapshotRetained: report.cancelledSnapshotRetained,
    cleanup: report.cleanup,
    failure: report.failure,
    events: report.events.map((event) => ({ ...event, elapsedMs: startedAt === null ? 0 : event.elapsedMs - startedAt })),
  };
}

function renderTimeline(receipt) {
  const rows = receipt.events.map((event) => `<tr><td>${event.elapsedMs}</td><td>${escapeHtml(event.kind)}</td><td>${escapeHtml(event.type ?? event.status ?? "")}</td></tr>`).join("");
  const result = receipt.ok ? "passed" : receipt.failure ?? receipt.cleanup.failure ?? "failed";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent runtime verification timeline</title><style>body{font:14px system-ui;margin:2rem;color:#172033}table{border-collapse:collapse}td,th{border:1px solid #cbd5e1;padding:.4rem .7rem;text-align:left}code{background:#eef2ff;padding:.15rem .3rem}</style><h1>Agent runtime verification timeline</h1><p>Scenario: <code>${escapeHtml(receipt.scenario)}</code>. Provider: <code>${escapeHtml(receipt.provider)}</code>. Thread: <code>${escapeHtml(receipt.thread ?? "unavailable")}</code>.</p><p>Result: <code>${escapeHtml(result)}</code>.</p><table><thead><tr><th>Elapsed ms</th><th>Channel</th><th>Event</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}

function diagnostics(repoRoot) {
  const evidenceDirectory = resolveEvidenceDirectory(repoRoot, false);
  return {
    command: "diagnostics",
    receipts: summarizeFiles(evidenceDirectory, 20),
    note: "Receipt file names, sizes, and modification times are shown. Raw receipt contents are not emitted.",
  };
}

function cleanup(repoRoot) {
  const evidenceDirectory = resolveEvidenceDirectory(repoRoot, false);
  if (!NodeFS.existsSync(evidenceDirectory)) {
    return { command: "cleanup", removed: [], removedCount: 0, directoryRemoved: false, runtimeStopped: false, databaseReset: false };
  }
  const removed = [];
  for (const entry of NodeFS.readdirSync(evidenceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !isHarnessEvidenceFile(entry.name)) continue;
    const candidate = NodePath.join(evidenceDirectory, entry.name);
    NodeFS.rmSync(candidate);
    removed.push(relativeTo(repoRoot, candidate));
  }
  const directoryRemoved = NodeFS.readdirSync(evidenceDirectory).length === 0;
  if (directoryRemoved) NodeFS.rmdirSync(evidenceDirectory);
  return {
    command: "cleanup",
    removed,
    removedCount: removed.length,
    directoryRemoved,
    runtimeStopped: false,
    databaseReset: false,
  };
}

function isHarnessEvidenceFile(name) {
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/;
  if (!timestamp.test(name)) return false;
  return /^(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:completion|stop)-(?:receipt\.json|timeline\.html)|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:focused-agent-runtime|verify-changed|lint-fast)\.log)$/.test(name);
}

function ensureEvidenceDirectory(repoRoot) {
  return resolveEvidenceDirectory(repoRoot, true);
}

function resolveEvidenceDirectory(repoRoot, createDirectory) {
  const runtimePaths = getRuntimePaths(repoRoot);
  const evidenceDirectory = NodePath.join(repoRoot, EVIDENCE_DIRECTORY);
  assertInsideDevDir(evidenceDirectory, runtimePaths.devDir);
  assertEvidenceComponentsAreNotLinks(runtimePaths.devDir, evidenceDirectory);
  if (!createDirectory && !NodeFS.existsSync(evidenceDirectory)) return evidenceDirectory;
  NodeFS.mkdirSync(evidenceDirectory, { recursive: true });
  assertEvidenceComponentsAreNotLinks(runtimePaths.devDir, evidenceDirectory);
  assertRealEvidenceDirectory(runtimePaths.devDir, evidenceDirectory);
  return evidenceDirectory;
}

function assertEvidenceComponentsAreNotLinks(devDirectory, evidenceDirectory) {
  const verificationDirectory = NodePath.join(devDirectory, "verification");
  for (const component of [devDirectory, verificationDirectory, evidenceDirectory]) {
    let status;
    try {
      status = NodeFS.lstatSync(component);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!status.isSymbolicLink()) continue;
    throw actionable(`Evidence directory component is a symbolic link or junction: ${relativePath(component)}`, "Replace the linked .dev verification path with directories inside this worktree, then retry.");
  }
}

function assertRealEvidenceDirectory(devDirectory, evidenceDirectory) {
  const realDevDirectory = NodeFS.realpathSync.native(devDirectory);
  const realEvidenceDirectory = NodeFS.realpathSync.native(evidenceDirectory);
  if (isPathInside(realEvidenceDirectory, realDevDirectory)) return;
  throw actionable("The evidence directory resolves outside the real .dev directory", "Replace the .dev verification path with directories inside this worktree, then retry.");
}

function isPathInside(candidate, directory) {
  const relative = NodePath.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== ".." && !NodePath.isAbsolute(relative));
}

function relativePath(path) {
  return NodePath.relative(resolveRepoRoot(), path).replace(/\\/g, "/");
}

async function openSocket(repoRoot, ports, onPush = () => {}) {
  const serverRequire = NodeModule.createRequire(NodePath.join(repoRoot, "apps", "server", "package.json"));
  const { WebSocket } = serverRequire("ws");
  const endpoint = new URL(`ws://127.0.0.1:${ports.serverPort}/`);
  endpoint.searchParams.set("instanceToken", ports.instanceToken);
  endpoint.searchParams.set("worktree", ports.worktreeIdentity);
  const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${ports.seedLogin.token}` } });
  const pending = new Map();
  const state = { failure: null, closing: false, counter: 0, openState: WebSocket.OPEN };
  attachSocketHandlers(ws, state, pending, onPush);
  await waitForSocketOpen(ws, state, pending);
  return createSocketClient(ws, state, pending);
}

function attachSocketHandlers(ws, state, pending, onPush) {
  ws.on("error", () => failSocket(ws, state, pending, socketFailure("The WebSocket connection failed", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry inspect or live.")));
  ws.on("close", () => {
    if (!state.closing) failSocket(ws, state, pending, socketFailure("The WebSocket closed unexpectedly", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry inspect or live."));
  });
  ws.on("message", (raw) => handleSocketMessage(ws, state, pending, onPush, raw));
}

function handleSocketMessage(ws, state, pending, onPush, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  if (message?.type === "refusal") {
    failSocket(ws, state, pending, refusalFailure(message));
    return;
  }
  if (message?.type === "push") {
    onPush(message);
    return;
  }
  settleRpcResponse(pending, message);
}

function refusalFailure(message) {
  const code = typeof message?.error?.code === "string" ? message.error.code : "UNKNOWN";
  return socketFailure(`The WebSocket attachment was refused (${code})`, "Start the runtime for this worktree, then retry inspect or live.");
}

function settleRpcResponse(pending, message) {
  const entry = pending.get(message?.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(message.id);
  if (message.error) {
    entry.reject(actionable(`RPC ${entry.method} failed (${String(message.error.code ?? "UNKNOWN")})`, "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry the command."));
    return;
  }
  entry.resolve(message.result);
}

async function waitForSocketOpen(ws, state, pending) {
  if (state.failure) throw state.failure;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      const error = socketFailure("The WebSocket did not connect within 15 seconds", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry inspect or live.");
      failSocket(ws, state, pending, error);
      finish(error);
    }, HEALTH_TIMEOUT_MS);
    ws.once("open", () => finish(null));
    ws.once("error", () => finish(state.failure));
    ws.once("close", () => finish(state.failure));
  });
}

function createSocketClient(ws, state, pending) {
  return {
    rpc: (method, params, deadline) => sendSocketRpc(ws, state, pending, method, params, deadline),
    close: () => closeSocketClient(ws, state, pending),
  };
}

function sendSocketRpc(ws, state, pending, method, params, deadline) {
  if (state.failure) return Promise.reject(state.failure);
  if (ws.readyState !== state.openState) {
    return Promise.reject(socketFailure("The WebSocket is not open", "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry the command."));
  }
  const id = `verify-${++state.counter}`;
  const timeout = deadline === undefined ? HEALTH_TIMEOUT_MS : Math.max(1, deadline - Date.now());
  const timeoutDescription = deadline === undefined ? "within 15 seconds" : "before the live deadline";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(actionable(`RPC ${method} did not respond ${timeoutDescription}`, "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry the command."));
    }, timeout);
    pending.set(id, { method, resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      reject(socketFailure(`RPC ${method} could not be sent`, "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry the command."));
    }
  });
}

function failSocket(ws, state, pending, error) {
  if (state.failure || state.closing) return;
  state.failure = error;
  rejectPendingRpc(pending, error);
  try { ws.terminate(); } catch { /* The socket can already be closed. */ }
}

function rejectPendingRpc(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

function closeSocketClient(ws, state, pending) {
  state.closing = true;
  rejectPendingRpc(pending, socketFailure("The WebSocket closed before the RPC completed", "Retry the command after the runtime is healthy."));
  if (ws.readyState === 3) return Promise.resolve();
  if (ws.readyState === 2) {
    ws.terminate();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (ws.readyState !== 3) ws.terminate();
      resolve();
    }, 1_000);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close();
  });
}

function socketFailure(condition, action) {
  return actionable(condition, action);
}

async function waitFor(predicate, deadline) {
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delayUntil(deadline);
  }
  return null;
}

async function waitForAsync(predicate, deadline) {
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delayUntil(deadline);
  }
  return false;
}

function delayUntil(deadline) {
  return delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathsMatch(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value) {
  let resolved = NodePath.resolve(String(value));
  try { resolved = NodeFS.realpathSync.native(resolved); } catch { /* The workspace path may not exist after removal. */ }
  resolved = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function redactRuntimeSnapshot(snapshot) {
  return { thread: fingerprint(snapshot?.threadId), phase: snapshot?.phase ?? null, savingStatus: snapshot?.savingStatus ?? null, hasExecution: Boolean(snapshot?.turnExecutionId) };
}

function fingerprint(value) {
  return typeof value === "string" ? `sha256:${NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}` : null;
}

function summarizeFiles(directory, limit) {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const stat = NodeFS.statSync(NodePath.join(directory, entry.name));
      return { name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    .slice(0, limit);
}

function firstFailure(stdout, stderr) {
  const line = `${stderr}\n${stdout}`.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "Command failed without output";
  return safeText(line);
}

function cliError(condition) {
  return actionable(condition, "Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime --help.");
}

function actionable(condition, nextAction) {
  return new Error(`Condition: ${condition}. Next action: ${nextAction}`);
}

function safeError(error) {
  const message = safeText(error instanceof Error ? error.message : String(error));
  return message.startsWith("Condition:")
    ? message
    : `Condition: ${message} Next action: Run bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime --help.`;
}

function safeText(value) {
  return String(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(token|cookie|instanceToken|authHeader)\s*[=:]\s*[^\s,}]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_ERROR_CHARS);
}

function relativeTo(repoRoot, path) {
  return NodePath.relative(repoRoot, path).replace(/\\/g, "/");
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

try {
  process.exitCode = await main();
} catch (error) {
  printJson({ ok: false, error: safeError(error) });
  process.exitCode = 1;
}
