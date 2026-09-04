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
const WORKTREE_SETUP_ACTIVE_RUN_FILE = "worktree-setup-active-run.json";
const WORKTREE_SETUP_MARKER = ".mcode-worktree-setup-proof";
const WORKTREE_SETUP_PID_FILE = ".mcode-worktree-setup.pid";
const WORKTREE_SETUP_SOURCE_FILES = Object.freeze({
  "checkout-root.txt": "root checkout complete\n",
  "fixtures/nested/checkout-nested.txt": "nested checkout complete\n",
  "fixtures/nested/deep/checkout-deep.txt": "deep checkout complete\n",
});
const WORKTREE_SETUP_SCRIPT_FILE = "verify-checkout.mjs";
const WORKTREE_SETUP_MANIFEST_FILE = "checkout-manifest.json";
const WORKTREE_SETUP_TRACKED_FILES = Object.freeze([
  ...Object.keys(WORKTREE_SETUP_SOURCE_FILES),
  WORKTREE_SETUP_MANIFEST_FILE,
  WORKTREE_SETUP_SCRIPT_FILE,
].sort());
const RUNTIME_SOURCE_DIRECTORIES = [
  ["apps", "server", "src"],
  ["packages", "contracts", "src"],
  ["packages", "providers", "src"],
  ["packages", "shared", "src"],
];
const PROVIDERS = new Set(["codex", "claude", "cursor", "opencode"]);
const SCENARIOS = new Set(["completion", "stop", "subagent"]);
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
  "src/features/agents/canonical/__tests__/canonical-agent-event-sink.test.ts",
  "src/features/agents/collaboration/adapters/__tests__/codex-collaboration-event-adapter.test.ts",
  "src/features/providers/composition/__tests__/provider-event-ingress.test.ts",
  "src/features/projects/git/__tests__/git-service-push.test.ts",
];
const FIXED_PROMPTS = {
  completion: "Reply with exactly: Agent runtime verification complete. Do not edit files or invoke tools.",
  stop: "Inspect this repository with read-only file-search and file-reading tools. Do not write files, change settings, or run mutating commands. Explain the repository structure in detail.",
  subagent: "Use exactly one subagent through provider-native collaboration. Give it this task: VERIFY_SUBAGENT_PARENT_TASK: wait five seconds without modifying files, then reply exactly VERIFY_SUBAGENT_CHILD_MESSAGE. After it finishes, reply exactly VERIFY_SUBAGENT_PARENT_DONE.",
};

const HELP = `Verify Mcode runtime

Usage:
  bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime <command> [options]

Commands:
  health
      Validate this worktree's .dev/ports.json and GET /health. Does not start a runtime.
  check
      Run focused AgentService/event tests and bun run lint.
  inspect
      Read active runtime and workspace summaries through the authenticated WebSocket RPC API.
  live --provider <codex|claude|cursor|opencode> --model <id> --scenario <completion|stop|subagent> --confirm-provider-call [--keep-thread]
      Make one confirmed provider call in the registered current-worktree workspace. Does not start a runtime.
  worktree-setup --confirm-cleanup
      Create an owned Git project, verify its held automatic Setup gate, cancel Setup through the public API, then remove the project, workspace, thread, and worktree. Does not make a provider call.
  worktree-setup-cleanup --confirm-cleanup
      Remove a retained worktree-setup run after an interrupted proof.
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
  if (command === "live") return parseLiveArguments(rest);
  if (["worktree-setup", "worktree-setup-cleanup"].includes(command)) return parseCleanupConfirmedCommand(command, rest);
  return parseOptionlessCommand(command, rest);
}

function validateCommand(command) {
  if (["health", "check", "inspect", "live", "worktree-setup", "worktree-setup-cleanup", "diagnostics", "cleanup"].includes(command)) return;
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

function parseCleanupConfirmedCommand(command, rest) {
  if (rest.length === 1 && rest[0] === "--confirm-cleanup") return { command };
  throw cliError(`${command} requires --confirm-cleanup`);
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
  if (!PROVIDERS.has(provider)) throw cliError("--provider must be codex, claude, cursor, or opencode");
  if (typeof model !== "string" || !/^[^\s]{1,256}$/.test(model)) throw cliError("--model must be a non-empty ID of at most 256 non-space characters");
  if (!SCENARIOS.has(scenario)) throw cliError("--scenario must be completion, stop, or subagent");
  if (scenario === "subagent" && (provider !== "codex" || model !== "gpt-5.6-terra")) {
    throw cliError("the subagent scenario requires --provider codex --model gpt-5.6-terra");
  }
  if (options.has("--confirm-provider-call")) return;
  throw actionable("Provider confirmation is missing", "Add --confirm-provider-call after you choose an available provider and model.");
}

async function execute(parsed, repoRoot) {
  try {
    if (parsed.command === "health") return success(await health(repoRoot));
    if (parsed.command === "check") return await check(repoRoot);
    if (parsed.command === "inspect") return success(await inspect(repoRoot));
    if (parsed.command === "live") return await live(repoRoot, parsed);
    if (parsed.command === "worktree-setup") return await worktreeSetup(repoRoot);
    if (parsed.command === "worktree-setup-cleanup") return success(await worktreeSetupCleanup(repoRoot));
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
    throw actionable("/health did not return status=ok with a non-negative activeAgents count", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then restart this worktree runtime.");
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

/** Opens the authenticated worktree runtime socket for another verifier area. */
export async function openRuntimeVerificationSocket(repoRoot, onPush = () => {}) {
  return await openSocket(repoRoot, readRuntime(repoRoot), onPush);
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
      throw actionable("Runtime RPC returned an unexpected active-agent, running-turn, or workspace summary", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry inspect.");
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
    { name: "focused-agent-runtime", args: ["run", "--cwd", "apps/server", "test", "--", ...FOCUSED_TEST_FILES] },
    { name: "codex-subagent-protocol", args: ["run", "--cwd", "packages/providers", "test", "--", "src/__tests__/codex/codex-app-server-handshake.test.ts", "src/__tests__/codex/codex-provider-subagent-turn.test.ts"] },
    { name: "subagent-presentation-contract", args: ["test", "packages/contracts/src/__tests__/subagent-presentation.test.ts"] },
    { name: "subagent-ui", args: ["run", "--cwd", "apps/web", "test", "--", "src/features/conversation/narrative/__tests__/build-persisted-narrative.test.ts", "src/features/conversation/narrative/__tests__/SubagentRow.test.tsx", "src/features/subagents/roster/__tests__/subagent-projection.test.ts", "src/features/subagents/roster/__tests__/SubagentsPanel.test.tsx"] },
    { name: "lint", args: ["run", "lint"] },
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

async function worktreeSetup(repoRoot) {
  const run = createWorktreeSetupRun(repoRoot);
  const report = createWorktreeSetupReport();
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  let socket = null;
  try {
    await health(repoRoot);
    socket = await openSocket(repoRoot, readRuntime(repoRoot));
    await createWorktreeSetupFixture(run.record);
    const workspace = await createWorktreeSetupWorkspace(socket, run.evidenceDirectory, run.record, deadline);
    await saveWorktreeSetupConfiguration(socket, workspace.id, deadline);
    const thread = await createWorktreeSetupThread(socket, workspace.id, run.record.startupId, deadline);
    recordWorktreeSetupThread(run.evidenceDirectory, run.record, thread);
    report.checkout = await proveWorktreeSetup(socket, run.evidenceDirectory, run.record, deadline);
    report.cancellation = await cancelWorktreeSetup(socket, run.record, deadline);
  } catch (error) {
    report.failure = safeError(error);
  } finally {
    try {
      report.cleanup = await cleanupWorktreeSetupRun(socket, run.evidenceDirectory, run.record, Date.now() + LIVE_TIMEOUT_MS);
    } catch (error) {
      report.cleanup.failure = safeError(error);
    }
    await socket?.close();
  }
  return writeWorktreeSetupReceipt(repoRoot, run.receiptPath, report);
}

function createWorktreeSetupReport() {
  return {
    command: "worktree-setup",
    checkout: null,
    cancellation: null,
    cleanup: {
      attempted: false,
      threadDeleted: null,
      worktreeRemoved: null,
      workspaceDeleted: null,
      sourceRepositoryRemoved: false,
      failure: null,
    },
    failure: null,
  };
}

function createWorktreeSetupRun(repoRoot) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  if (readWorktreeSetupActiveRun(evidenceDirectory)) {
    throw actionable("A previous worktree Setup proof still owns generated state", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime worktree-setup-cleanup --confirm-cleanup, then retry.");
  }
  const id = `${fileStamp()}-${NodeCrypto.randomUUID()}`;
  const runsDirectory = NodePath.join(evidenceDirectory, "runs");
  NodeFS.mkdirSync(runsDirectory, { recursive: true });
  assertDirectoryIsNotLinked(runsDirectory, "worktree Setup runs directory");
  const runDirectory = NodePath.join(runsDirectory, id);
  NodeFS.mkdirSync(runDirectory);
  const record = {
    id,
    runDirectory,
    sourceRepositoryPath: NodePath.join(runDirectory, "source"),
    startupId: NodeCrypto.randomUUID(),
    workspaceId: null,
    threadId: null,
    worktreePath: null,
    setupProcessId: null,
  };
  writeWorktreeSetupActiveRun(evidenceDirectory, record);
  return {
    evidenceDirectory,
    record,
    receiptPath: NodePath.join(evidenceDirectory, `${fileStamp()}-worktree-setup-receipt.json`),
  };
}

async function createWorktreeSetupFixture(record) {
  const sourceRepositoryPath = record.sourceRepositoryPath;
  NodeFS.mkdirSync(sourceRepositoryPath);
  await runFixtureGit(sourceRepositoryPath, ["init", "--quiet", "--initial-branch=main"]);
  const hooksDirectory = NodePath.join(sourceRepositoryPath, ".git", "verify-mcode-hooks");
  NodeFS.mkdirSync(hooksDirectory);
  await runFixtureGit(sourceRepositoryPath, ["config", "user.email", "verify-mcode@example.invalid"]);
  await runFixtureGit(sourceRepositoryPath, ["config", "user.name", "Mcode verifier"]);
  await runFixtureGit(sourceRepositoryPath, ["config", "commit.gpgsign", "false"]);
  await runFixtureGit(sourceRepositoryPath, ["config", "core.autocrlf", "false"]);
  await runFixtureGit(sourceRepositoryPath, ["config", "core.hooksPath", hooksDirectory]);
  for (const [relativePath, contents] of Object.entries(WORKTREE_SETUP_SOURCE_FILES)) {
    const path = NodePath.join(sourceRepositoryPath, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
  }
  NodeFS.writeFileSync(
    NodePath.join(sourceRepositoryPath, WORKTREE_SETUP_MANIFEST_FILE),
    `${JSON.stringify(WORKTREE_SETUP_TRACKED_FILES)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  NodeFS.writeFileSync(
    NodePath.join(sourceRepositoryPath, WORKTREE_SETUP_SCRIPT_FILE),
    worktreeSetupFixtureScript(),
    { encoding: "utf8", flag: "wx" },
  );
  await runFixtureGit(sourceRepositoryPath, ["add", "."]);
  await runFixtureGit(sourceRepositoryPath, ["commit", "--quiet", "-m", "verification fixture"]);
}

async function runFixtureGit(cwd, args) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...childCommandEnvironment(), GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode === 0) return stdout;
  throw actionable(`Fixture Git ${args[0]} failed: ${firstFailure(stdout, stderr)}`, "Check the local Git installation, then retry worktree Setup verification.");
}

async function createWorktreeSetupWorkspace(socket, evidenceDirectory, record, deadline) {
  const workspace = await socket.rpc("workspace.create", {
    name: `Verify worktree Setup ${record.id.slice(-8)}`,
    path: record.sourceRepositoryPath,
  }, deadline);
  if (!isOwnedWorktreeSetupWorkspace(workspace, record)) {
    throw actionable("workspace.create did not return the owned fixture workspace", "Run worktree-setup-cleanup with --confirm-cleanup, inspect runtime diagnostics, then retry.");
  }
  record.workspaceId = workspace.id;
  writeWorktreeSetupActiveRun(evidenceDirectory, record);
  return workspace;
}

async function saveWorktreeSetupConfiguration(socket, workspaceId, deadline) {
  const saved = await socket.rpc("workspace.environment.save", {
    workspaceId,
    sourceRevision: null,
    document: {
      version: "0.0.1",
      setup: { default: `bun ${WORKTREE_SETUP_SCRIPT_FILE}` },
      actions: [],
    },
  }, deadline);
  if (saved?.status === "present" && saved?.document?.setup?.default === `bun ${WORKTREE_SETUP_SCRIPT_FILE}`) return;
  throw actionable("workspace.environment.save did not retain the automatic Setup script", "Run worktree-setup-cleanup with --confirm-cleanup, then retry.");
}

function worktreeSetupFixtureScript() {
  const expectedContents = JSON.stringify(WORKTREE_SETUP_SOURCE_FILES);
  return [
    'import * as fs from "node:fs";',
    'import * as child from "node:child_process";',
    `const expectedContents = ${expectedContents};`,
    `const expectedFiles = JSON.parse(fs.readFileSync("${WORKTREE_SETUP_MANIFEST_FILE}", "utf8"));`,
    'const trackedFiles = child.execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split(/\\r?\\n/).filter(Boolean).sort();',
    'if (JSON.stringify(trackedFiles) !== JSON.stringify(expectedFiles)) throw new Error("checkout fixture is incomplete");',
    'for (const path of expectedFiles) if (!fs.existsSync(path)) throw new Error("checkout fixture is incomplete");',
    'for (const [path, contents] of Object.entries(expectedContents)) if (fs.readFileSync(path, "utf8") !== contents) throw new Error("checkout fixture is incomplete");',
    `fs.writeFileSync("${WORKTREE_SETUP_MARKER}", "ready\\n");`,
    'fs.writeFileSync("' + WORKTREE_SETUP_PID_FILE + '", `${process.pid}\\n`);',
    'await new Promise(() => {});',
    '',
  ].join("\n");
}

async function createWorktreeSetupThread(socket, workspaceId, startupId, deadline) {
  const thread = await socket.rpc("agent.createAndSend", {
    workspaceId,
    startupId,
    content: "Verify automatic Setup checkout readiness.",
    model: "claude-sonnet-4-6",
    provider: "claude",
    permissionMode: "full",
    mode: "worktree",
    branch: "main",
  }, deadline);
  if (
    typeof thread?.id !== "string" ||
    typeof thread?.worktree_path !== "string" ||
    thread.mode !== "worktree" ||
    thread.worktree_managed !== true ||
    thread.runtimeSnapshot?.phase !== "idle"
  ) {
    throw actionable("agent.createAndSend did not retain a queued managed worktree turn", "Run worktree-setup-cleanup with --confirm-cleanup, inspect runtime diagnostics, then retry.");
  }
  return thread;
}

function recordWorktreeSetupThread(evidenceDirectory, record, thread) {
  record.threadId = thread.id;
  record.worktreePath = thread.worktree_path;
  writeWorktreeSetupActiveRun(evidenceDirectory, record);
}

async function proveWorktreeSetup(socket, evidenceDirectory, record, deadline) {
  const automatic = await waitForRunningAutomaticSetup(socket, record.threadId, deadline);
  if (!isRunningWorktreeSetup(automatic, record.worktreePath) || !hasQueuedFirstTurn(automatic)) {
    throw actionable("Automatic Setup did not remain active with its first Turn queued", "Run worktree-setup-cleanup with --confirm-cleanup, inspect runtime diagnostics, then retry.");
  }
  const markerWritten = await waitFor(() => hasCompleteWorktreeCheckout(record.worktreePath), deadline);
  if (!markerWritten) {
    throw actionable("Automatic Setup did not write its checkout proof marker before the live deadline", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect automatic Setup execution.");
  }
  assertCompleteWorktreeCheckout(record.worktreePath);
  const settledAutomatic = await socket.rpc("workspace.environment.automaticSetup.get", { threadId: record.threadId }, deadline);
  if (!isRunningWorktreeSetup(settledAutomatic, record.worktreePath) || !hasQueuedFirstTurn(settledAutomatic)) {
    throw actionable("Automatic Setup released its first Turn before cleanup", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect automatic Setup execution.");
  }
  const running = await socket.rpc("agent.listRunning", {}, deadline);
  if (!hasNoRuntimeForThread(running, record.threadId)) {
    throw actionable("The queued first Turn reached an agent runtime", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect automatic Setup execution.");
  }
  const setupProcessId = await waitFor(() => readWorktreeSetupProcessId(record.worktreePath), deadline);
  if (setupProcessId === null) {
    throw actionable("Automatic Setup did not record its process ID before the live deadline", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect automatic Setup execution.");
  }
  record.setupProcessId = setupProcessId;
  writeWorktreeSetupActiveRun(evidenceDirectory, record);
  return {
    automaticSetupState: settledAutomatic.attempt.state,
    checkoutPathMatchesWorktree: true,
    trackedFixtureFiles: WORKTREE_SETUP_TRACKED_FILES.length,
    proofMarker: true,
    firstTurnQueued: true,
  };
}

async function cancelWorktreeSetup(socket, record, deadline) {
  const cancelled = await socket.rpc("thread.startup.cancel", { startupId: record.startupId }, deadline);
  if (!isTerminalWorktreeSetupCancellation(cancelled, record)) {
    throw actionable("thread.startup.cancel did not return the terminal cancellation for the held Setup", "Run worktree-setup-cleanup with --confirm-cleanup, inspect runtime diagnostics, then retry.");
  }
  const setupProcessStopped = await waitFor(() => !isRecordedWorktreeSetupProcessAlive(record.setupProcessId), deadline);
  if (!setupProcessStopped) {
    throw actionable("The fixture Setup process remained alive after thread.startup.cancel returned", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect automatic Setup containment.");
  }
  const automatic = await socket.rpc("workspace.environment.automaticSetup.get", { threadId: record.threadId }, deadline);
  if (!isInterruptedWorktreeSetup(automatic, record.worktreePath) || !hasQueuedFirstTurn(automatic)) {
    throw actionable("Automatic Setup did not remain interrupted with its first Turn queued after cancellation", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect automatic Setup containment.");
  }
  const running = await socket.rpc("agent.listRunning", {}, deadline);
  if (!hasNoRuntimeForThread(running, record.threadId)) {
    throw actionable("The cancelled queued first Turn reached an agent runtime", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect startup admission.");
  }
  return {
    state: "cancelled",
    cancellation: "requested",
    startupIdMatches: true,
    threadIdMatches: true,
    setupStepCancelled: true,
    agentStepPending: true,
    setupProcessTerminated: true,
    automaticSetupState: "interrupted",
    firstTurnQueued: true,
    noAgentRuntime: true,
    providerCallMade: false,
  };
}

function isTerminalWorktreeSetupCancellation(startup, record) {
  if (!hasTerminalWorktreeSetupShape(startup, record)) return false;
  return hasStartupStep(startup, "setup", "cancelled") && hasStartupStep(startup, "agent", "pending");
}

function hasTerminalWorktreeSetupShape(startup, record) {
  return startup?.startupId === record.startupId
    && startup?.threadId === record.threadId
    && startup?.state === "cancelled"
    && startup?.cancellation === "requested"
    && startup?.phase === "setup";
}

function hasStartupStep(startup, phase, state) {
  return Array.isArray(startup?.steps)
    && startup.steps.some((step) => step?.phase === phase && step.state === state);
}

function isInterruptedWorktreeSetup(automatic, worktreePath) {
  return automatic?.gate === "blocked"
    && automatic.attempt?.state === "interrupted"
    && pathsMatch(automatic.attempt.snapshot?.checkoutPath, worktreePath);
}

function readWorktreeSetupProcessId(worktreePath) {
  const path = NodePath.join(worktreePath, WORKTREE_SETUP_PID_FILE);
  const status = readWorktreeSetupPidFileStatus(path);
  if (status === null) return null;
  if (!isBoundedRegularFile(status)) {
    throw actionable("The fixture Setup process ID file is not a bounded regular file", "Run worktree-setup-cleanup with --confirm-cleanup, then retry.");
  }
  return parseWorktreeSetupProcessId(NodeFS.readFileSync(path, "utf8"));
}

function readWorktreeSetupPidFileStatus(path) {
  try {
    return NodeFS.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function isBoundedRegularFile(status) {
  return !status.isSymbolicLink() && status.isFile() && status.size >= 2 && status.size <= 12;
}

function parseWorktreeSetupProcessId(contents) {
  if (!/^[1-9]\d{0,9}\r?\n?$/.test(contents)) {
    throw actionable("The fixture Setup process ID file has invalid content", "Run worktree-setup-cleanup with --confirm-cleanup, then retry.");
  }
  const processId = Number(contents.trim());
  if (!isWorktreeSetupProcessId(processId)) {
    throw actionable("The fixture Setup process ID is outside the supported range", "Run worktree-setup-cleanup with --confirm-cleanup, then retry.");
  }
  return processId;
}

function isRecordedWorktreeSetupProcessAlive(processId) {
  if (!isWorktreeSetupProcessId(processId)) {
    throw actionable("The recorded fixture Setup process ID is invalid", "Run worktree-setup-cleanup with --confirm-cleanup, then retry.");
  }
  return isProcessAlive(processId);
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function errorCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isWorktreeSetupProcessId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 4_294_967_295;
}

function isRunningWorktreeSetup(automatic, worktreePath) {
  if (automatic?.gate !== "blocked") return false;
  if (automatic.attempt?.state !== "running") return false;
  return pathsMatch(automatic.attempt.snapshot?.checkoutPath, worktreePath);
}

function hasQueuedFirstTurn(automatic) {
  if (!Array.isArray(automatic?.queuedTurns)) return false;
  if (automatic.queuedTurns.length !== 1) return false;
  return automatic.queuedTurns[0]?.state === "queued";
}

function hasNoRuntimeForThread(running, threadId) {
  return Array.isArray(running) && !running.some((snapshot) => snapshot?.threadId === threadId);
}

async function waitForRunningAutomaticSetup(socket, threadId, deadline) {
  while (Date.now() < deadline) {
    const automatic = await socket.rpc("workspace.environment.automaticSetup.get", { threadId }, deadline);
    if (automatic?.attempt?.state === "running") return automatic;
    if (["awaiting-approval", "failed", "interrupted"].includes(automatic?.attempt?.state)) {
      throw actionable(`Automatic Setup reached ${automatic.attempt.state}`, "Run worktree-setup-cleanup with --confirm-cleanup, inspect runtime diagnostics, then retry.");
    }
    await delayUntil(deadline);
  }
  throw actionable("Automatic Setup did not begin before the 120-second live deadline", "Run worktree-setup-cleanup with --confirm-cleanup, inspect runtime diagnostics, then retry.");
}

function assertCompleteWorktreeCheckout(worktreePath) {
  if (hasCompleteWorktreeCheckout(worktreePath)) return;
  throw actionable("Automatic Setup ran before the fixture checkout was complete", "Run worktree-setup-cleanup with --confirm-cleanup, then inspect the worktree creation flow.");
}

function hasCompleteWorktreeCheckout(worktreePath) {
  for (const relativePath of WORKTREE_SETUP_TRACKED_FILES) {
    if (!NodeFS.existsSync(NodePath.join(worktreePath, relativePath))) return false;
  }
  for (const [relativePath, expected] of Object.entries(WORKTREE_SETUP_SOURCE_FILES)) {
    const path = NodePath.join(worktreePath, relativePath);
    if (!NodeFS.existsSync(path) || NodeFS.readFileSync(path, "utf8") !== expected) return false;
  }
  const marker = NodePath.join(worktreePath, WORKTREE_SETUP_MARKER);
  return NodeFS.existsSync(marker) && NodeFS.readFileSync(marker, "utf8") === "ready\n";
}

async function cleanupWorktreeSetupRun(socket, evidenceDirectory, record, deadline) {
  const cleanup = {
    attempted: true,
    threadDeleted: null,
    worktreeRemoved: null,
    workspaceDeleted: null,
    sourceRepositoryRemoved: false,
    failure: null,
  };
  if (socket) await removeWorktreeSetupRuntimeResources(socket, evidenceDirectory, record, cleanup, deadline);
  if (!socket && record.workspaceId) {
    throw actionable("The runtime connection ended before generated state could be removed", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is healthy.");
  }
  await removeOwnedFixtureWorktrees(evidenceDirectory, record, cleanup);
  await removeOwnedWorktreeSetupRunDirectory(evidenceDirectory, record, deadline);
  removeWorktreeSetupActiveRun(evidenceDirectory);
  cleanup.sourceRepositoryRemoved = true;
  return cleanup;
}

async function removeWorktreeSetupRuntimeResources(socket, evidenceDirectory, record, cleanup, deadline) {
  const workspace = await findOwnedWorktreeSetupWorkspace(socket, record, deadline);
  if (!workspace) return;
  record.workspaceId = workspace.id;
  writeWorktreeSetupActiveRun(evidenceDirectory, record);
  await removeOwnedWorktreeSetupThreads(socket, workspace.id, cleanup, deadline);
  const workspaceDeleted = await socket.rpc("workspace.forceDelete", { id: workspace.id }, deadline);
  if (workspaceDeleted !== true) throw actionable("workspace.forceDelete did not confirm removal of the generated workspace", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is healthy.");
  cleanup.workspaceDeleted = true;
}

async function findOwnedWorktreeSetupWorkspace(socket, record, deadline) {
  const workspaces = await socket.rpc("workspace.list", {}, deadline);
  if (!Array.isArray(workspaces)) throw actionable("workspace.list returned an unexpected value during cleanup", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is healthy.");
  const owned = workspaces.filter((workspace) => isOwnedWorktreeSetupWorkspace(workspace, record));
  if (owned.length === 0) return null;
  if (owned.length === 1) return owned[0];
  throw actionable("The retained worktree Setup run matches multiple workspaces", "Inspect the verifier evidence before cleanup. Do not delete a workspace by guesswork.");
}

async function removeOwnedWorktreeSetupThreads(socket, workspaceId, cleanup, deadline) {
  const threads = await socket.rpc("thread.list", { workspaceId }, deadline);
  if (!Array.isArray(threads) || threads.some((thread) => typeof thread?.id !== "string")) {
    throw actionable("thread.list returned an unexpected value during cleanup", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is healthy.");
  }
  for (const thread of threads) {
    const deleted = await socket.rpc("thread.delete", { threadId: thread.id, cleanupWorktree: true }, deadline);
    if (deleted !== true) throw actionable("thread.delete did not confirm removal of a generated thread", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is healthy.");
  }
  const removed = await waitForAsync(async () => {
    const remaining = await socket.rpc("thread.list", { workspaceId }, deadline);
    return Array.isArray(remaining) && remaining.length === 0;
  }, deadline);
  if (!removed) throw actionable("Generated thread cleanup did not finish before the live deadline", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is healthy.");
  cleanup.threadDeleted = true;
}

function isOwnedWorktreeSetupWorkspace(workspace, record) {
  return typeof workspace?.id === "string"
    && workspace.id.length > 0
    && typeof workspace.path === "string"
    && pathsMatch(workspace.path, record.sourceRepositoryPath);
}

async function removeOwnedFixtureWorktrees(evidenceDirectory, record, cleanup) {
  if (!NodeFS.existsSync(NodePath.join(record.sourceRepositoryPath, ".git"))) return;
  const listed = await runFixtureGit(record.sourceRepositoryPath, ["worktree", "list", "--porcelain"]);
  const worktrees = fixtureWorktreePaths(listed).filter((path) => !pathsMatch(path, record.sourceRepositoryPath));
  for (const worktreePath of worktrees) {
    assertOwnedFixtureWorktreePath(evidenceDirectory, worktreePath);
    await runFixtureGit(record.sourceRepositoryPath, ["worktree", "remove", "--force", worktreePath]);
  }
  const remaining = fixtureWorktreePaths(await runFixtureGit(record.sourceRepositoryPath, ["worktree", "list", "--porcelain"]));
  if (remaining.some((path) => !pathsMatch(path, record.sourceRepositoryPath))) {
    throw actionable("A generated fixture worktree remains after cleanup", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is idle.");
  }
  cleanup.worktreeRemoved = true;
}

function fixtureWorktreePaths(output) {
  return output.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function assertOwnedFixtureWorktreePath(evidenceDirectory, worktreePath) {
  const devDirectory = NodePath.resolve(evidenceDirectory, "..", "..");
  if (NodePath.isAbsolute(worktreePath) && isPathInside(NodePath.resolve(worktreePath), devDirectory)) return;
  throw actionable("The owned fixture repository references a worktree outside .dev", "Inspect the verifier evidence before cleanup.");
}

async function worktreeSetupCleanup(repoRoot) {
  const evidenceDirectory = ensureEvidenceDirectory(repoRoot);
  const record = readWorktreeSetupActiveRun(evidenceDirectory);
  if (!record) return { command: "worktree-setup-cleanup", activeRunRemoved: false };
  await health(repoRoot);
  const socket = await openSocket(repoRoot, readRuntime(repoRoot));
  try {
    const cleanup = await cleanupWorktreeSetupRun(socket, evidenceDirectory, record, Date.now() + LIVE_TIMEOUT_MS);
    return { command: "worktree-setup-cleanup", activeRunRemoved: true, cleanup };
  } finally {
    await socket.close();
  }
}

function writeWorktreeSetupReceipt(repoRoot, receiptPath, report) {
  const receipt = {
    ok: report.failure === null && report.cleanup.failure === null,
    command: report.command,
    checkout: report.checkout,
    cancellation: report.cancellation,
    cleanup: report.cleanup,
    failure: report.failure,
  };
  NodeFS.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return {
    exitCode: receipt.ok ? 0 : 1,
    output: { ...receipt, receiptPath: relativeTo(repoRoot, receiptPath) },
  };
}

function writeWorktreeSetupActiveRun(evidenceDirectory, record) {
  assertWorktreeSetupRunRecord(evidenceDirectory, record);
  const path = worktreeSetupActiveRunPath(evidenceDirectory);
  assertWorktreeSetupActiveRunFile(path);
  const temporaryPath = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assertWorktreeSetupActiveRunFile(path);
    NodeFS.renameSync(temporaryPath, path);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

function readWorktreeSetupActiveRun(evidenceDirectory) {
  const path = worktreeSetupActiveRunPath(evidenceDirectory);
  if (!assertWorktreeSetupActiveRunFile(path)) return null;
  let record;
  try {
    record = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    throw actionable("The retained worktree Setup run record is not valid JSON", "Inspect the verifier evidence before cleanup.");
  }
  return assertWorktreeSetupRunRecord(evidenceDirectory, record);
}

function removeWorktreeSetupActiveRun(evidenceDirectory) {
  const path = worktreeSetupActiveRunPath(evidenceDirectory);
  if (!assertWorktreeSetupActiveRunFile(path)) return;
  NodeFS.rmSync(path);
}

function worktreeSetupActiveRunPath(evidenceDirectory) {
  return NodePath.join(evidenceDirectory, WORKTREE_SETUP_ACTIVE_RUN_FILE);
}

function assertWorktreeSetupActiveRunFile(path) {
  let status;
  try {
    status = NodeFS.lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw actionable("The retained worktree Setup run record is not a regular file", "Inspect the verifier evidence before cleanup.");
  }
  return true;
}

function assertWorktreeSetupRunRecord(evidenceDirectory, record) {
  const normalized = normalizeLegacyWorktreeSetupRunRecord(record);
  assertWorktreeSetupRunShape(normalized);
  assertWorktreeSetupRunIdentity(normalized);
  assertWorktreeSetupRunThread(normalized);
  assertWorktreeSetupRunDirectory(evidenceDirectory, normalized);
  return normalized;
}

function normalizeLegacyWorktreeSetupRunRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const legacyKeys = ["id", "runDirectory", "sourceRepositoryPath", "threadId", "workspaceId", "worktreePath"];
  if (Object.keys(record).sort().join(",") !== legacyKeys.sort().join(",")) return record;
  return { ...record, startupId: null, setupProcessId: null };
}

function assertWorktreeSetupRunShape(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw actionable("The retained worktree Setup run record must be an object", "Inspect the verifier evidence before cleanup.");
  }
  const keys = ["id", "runDirectory", "sourceRepositoryPath", "startupId", "threadId", "workspaceId", "worktreePath", "setupProcessId"];
  if (Object.keys(record).sort().join(",") !== keys.sort().join(",")) {
    throw actionable("The retained worktree Setup run record has an unexpected shape", "Inspect the verifier evidence before cleanup.");
  }
}

function assertWorktreeSetupRunIdentity(record) {
  if (!isWorktreeSetupRunId(record.id) || !isOptionalUuid(record.startupId) || !isAbsolutePath(record.runDirectory) || !isAbsolutePath(record.sourceRepositoryPath)) {
    throw actionable("The retained worktree Setup run record has invalid paths or identity", "Inspect the verifier evidence before cleanup.");
  }
  if (!isOptionalWorktreeSetupId(record.workspaceId) || !isOptionalWorktreeSetupId(record.threadId)) {
    throw actionable("The retained worktree Setup run record has invalid workspace or thread identity", "Inspect the verifier evidence before cleanup.");
  }
}

function assertWorktreeSetupRunThread(record) {
  if (!isOptionalAbsolutePath(record.worktreePath) || (record.setupProcessId !== null && !isWorktreeSetupProcessId(record.setupProcessId))) {
    throw actionable("The retained worktree Setup run record has an invalid worktree identity", "Inspect the verifier evidence before cleanup.");
  }
  if (record.threadId === null && record.worktreePath !== null) {
    throw actionable("The retained worktree Setup run record has an invalid worktree identity", "Inspect the verifier evidence before cleanup.");
  }
  if (record.threadId !== null && record.worktreePath === null) {
    throw actionable("The retained worktree Setup run record has an invalid worktree identity", "Inspect the verifier evidence before cleanup.");
  }
  if (record.workspaceId !== null) return;
  if (record.threadId === null) return;
  throw actionable("The retained worktree Setup run record has a thread without its workspace", "Inspect the verifier evidence before cleanup.");
}

function assertWorktreeSetupRunDirectory(evidenceDirectory, record) {
  const runsDirectory = NodePath.resolve(evidenceDirectory, "runs");
  const expectedRunDirectory = NodePath.resolve(runsDirectory, record.id);
  const expectedSourcePath = NodePath.resolve(expectedRunDirectory, "source");
  if (!pathsMatch(record.runDirectory, expectedRunDirectory)) {
    throw actionable("The retained worktree Setup run record points outside its owned fixture directory", "Inspect the verifier evidence before cleanup.");
  }
  if (!pathsMatch(record.sourceRepositoryPath, expectedSourcePath)) {
    throw actionable("The retained worktree Setup run record points outside its owned fixture directory", "Inspect the verifier evidence before cleanup.");
  }
}

function isWorktreeSetupRunId(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}$/i.test(value);
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isOptionalUuid(value) {
  return value === null || isUuid(value);
}

function isOptionalWorktreeSetupId(value) {
  return value === null || (typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value));
}

function isOptionalAbsolutePath(value) {
  return value === null || isAbsolutePath(value);
}

function isAbsolutePath(value) {
  return typeof value === "string" && NodePath.isAbsolute(value);
}

function assertDirectoryIsNotLinked(path, label) {
  const status = NodeFS.lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw actionable(`The ${label} is not a real directory`, "Replace it with a directory inside .dev, then retry.");
  }
}

async function removeOwnedWorktreeSetupRunDirectory(evidenceDirectory, record, deadline) {
  assertWorktreeSetupRunRecord(evidenceDirectory, record);
  const runsDirectory = NodePath.join(evidenceDirectory, "runs");
  assertDirectoryIsNotLinked(runsDirectory, "worktree Setup runs directory");
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (NodeFS.existsSync(record.runDirectory)) {
        assertDirectoryIsNotLinked(record.runDirectory, "worktree Setup run directory");
        NodeFS.rmSync(record.runDirectory, { recursive: true, force: true });
      }
      if (NodeFS.readdirSync(runsDirectory).length === 0) NodeFS.rmdirSync(runsDirectory);
      return;
    } catch (error) {
      if (!isRetryableRunRemovalError(error)) throw error;
      lastError = error;
      await delayUntil(deadline);
    }
  }
  throw lastError ?? actionable("The generated worktree Setup run directory could not be removed", "Run worktree-setup-cleanup with --confirm-cleanup after the runtime is idle.");
}

function isRetryableRunRemovalError(error) {
  return error && typeof error === "object" && "code" in error && ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code);
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
    subagentActiveSeen: false,
    subagentCompleted: false,
    subagentTaskRetained: false,
    subagentParentMessageRetained: false,
    subagentMessageRetained: false,
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
  const workspace = await findLiveWorkspace(run.socket, repoRoot, options.scenario);
  run.proofDeadline = Date.now() + LIVE_TIMEOUT_MS;
  run.threadId = await createLiveThread(run.socket, workspace, repoRoot, options, run.proofDeadline);
  run.report.thread = fingerprint(run.threadId);
  const subscription = await subscribeToLiveThread(run.socket, run.threadId, run.proofDeadline);
  run.report.subscription = subscription;
  if (subscription.hydrationRequired) {
    throw actionable("The retained event journal requires hydration for the created thread", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime inspect, then retry live verification after hydration is available.");
  }
}

async function findCurrentWorkspace(socket, repoRoot) {
  const workspaces = await socket.rpc("workspace.list", {});
  if (!Array.isArray(workspaces)) {
    throw actionable("workspace.list returned an unexpected value", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime inspect, then retry live verification.");
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
  throw actionable("agent.createAndSend did not return a thread ID", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the server response.");
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
  if (scenario === "subagent") return proveSubagent(run);
  return proveStop(run);
}

async function findLiveWorkspace(socket, repoRoot, scenario) {
  if (scenario !== "subagent") return findCurrentWorkspace(socket, repoRoot);
  const fixtureRepo = getRuntimePaths(repoRoot).fixtureRepoDir;
  const workspaces = await socket.rpc("workspace.list", {});
  const workspace = Array.isArray(workspaces)
    ? workspaces.find((candidate) => candidate && pathsMatch(candidate.path, fixtureRepo))
    : null;
  if (workspace) return workspace;
  throw actionable(
    "The disposable fixture workspace is not registered",
    "Restart this worktree runtime with bun run --shell system agent:down and bun run --shell system agent:up.",
  );
}

async function proveSubagent(run) {
  const lifecycle = observeSubagentLifecycle(run);
  await requireTerminalEvent(run.report, run.proofDeadline);
  await requireDurableAssistant(run.socket, run.threadId, run.report, run.proofDeadline);
  await lifecycle;
}

async function observeSubagentLifecycle(run) {
  let childThreadId = null;
  const verified = await waitForAsync(async () => {
    const roster = await run.socket.rpc("canonicalAgent.roster", {
      owningParentThreadId: run.threadId,
    }, run.proofDeadline);
    if (Array.isArray(roster?.active) && roster.active.length > 0) {
      run.report.subagentActiveSeen = true;
    }
    const child = Array.isArray(roster?.done)
      ? roster.done.find((row) => row?.terminalOutcome === "Completed")
      : null;
    if (!child) return false;
    childThreadId = child.id;
    run.report.subagentCompleted = true;
    run.report.subagentTaskRetained = hasDescriptiveSubagentTask(child);
    const conversation = await run.socket.rpc("conversation.page", { threadId: child.id, limit: 100 }, run.proofDeadline);
    run.report.subagentParentMessageRetained = hasMessageText(
      conversation,
      "user",
      "VERIFY_SUBAGENT_PARENT_TASK",
    );
    run.report.subagentMessageRetained = hasAssistantText(conversation, "VERIFY_SUBAGENT_CHILD_MESSAGE");
    return run.report.subagentActiveSeen
      && run.report.subagentTaskRetained
      && run.report.subagentParentMessageRetained
      && run.report.subagentMessageRetained;
  }, run.proofDeadline);
  if (verified) return;
  throw actionable(
    `The Codex subagent workflow was incomplete${childThreadId ? " for the recorded child" : ""}`,
    "Inspect the redacted receipt, Codex protocol trace, and canonical roster before retrying with Terra.",
  );
}

function hasDescriptiveSubagentTask(child) {
  if (typeof child?.task !== "string") return false;
  const task = child.task.trim().toLowerCase();
  const identity = typeof child.identity === "string" ? child.identity.trim().toLowerCase() : "subagent";
  return task.includes("verify") && task !== identity && task !== "subagent";
}

async function proveCompletion(run) {
  await requireTerminalEvent(run.report, run.proofDeadline);
  await requireDurableAssistant(run.socket, run.threadId, run.report, run.proofDeadline);
}

async function requireTerminalEvent(report, deadline) {
  const outcome = await waitFor(() => findCompletionOutcome(report.events), deadline);
  if (!outcome) {
    throw actionable("No terminal provider event arrived before the 120-second live deadline", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry with an available model.");
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
  throw actionable("Durable assistant data did not appear through both conversation.page and message.list before the 120-second live deadline", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry completion.");
}

async function proveStop(run) {
  await requireTurnStarted(run.report, run.proofDeadline);
  run.report.stopResults = await Promise.all([
    run.socket.rpc("agent.stop", { threadId: run.threadId }, run.proofDeadline),
    run.socket.rpc("agent.stop", { threadId: run.threadId }, run.proofDeadline),
  ]);
  run.report.sharedStopResult = hasSharedStopResult(run.report.stopResults, run.threadId);
  if (!run.report.sharedStopResult) {
    throw actionable("Concurrent agent.stop calls did not return one shared cancelled outcome", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry stop verification.");
  }
  await requireStoppedOutcome(run.report, run.proofDeadline);
  await requireCancelledRuntimeState(run.socket, run.threadId, run.report, run.proofDeadline);
}

async function requireTurnStarted(report, deadline) {
  const started = await waitFor(() => report.events.some((event) => event.kind === "agent" && event.type === "turnStarted"), deadline);
  if (started) return;
  throw actionable("No turnStarted event arrived before the 120-second live deadline", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry stop verification.");
}

async function requireStoppedOutcome(report, deadline) {
  const stopped = await waitFor(() => hasStoppedStatus(report.events), deadline);
  if (stopped) return;
  throw actionable("Concurrent agent.stop calls did not produce a cancelled, interrupted, or paused outcome", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect the receipt and retry stop verification.");
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
  throw actionable("The stopped turn did not clear agent.activeCount while retaining its matching cancelled snapshot before the 120-second live deadline", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then inspect teardown and retry stop verification.");
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

function hasAssistantText(value, expectedText) {
  return hasMessageText(value, "assistant", expectedText);
}

function hasMessageText(value, role, expectedText) {
  return Array.isArray(value?.messages)
    && value.messages.some((message) => message?.role === role
      && typeof message.content === "string"
      && message.content.includes(expectedText));
}

function summarizeSubscription(subscription, threadId) {
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) {
    throw actionable("push.setThreadSubscriptions returned an unexpected replay result", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry live verification.");
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
    subagentActiveSeen: report.subagentActiveSeen,
    subagentCompleted: report.subagentCompleted,
    subagentTaskRetained: report.subagentTaskRetained,
    subagentParentMessageRetained: report.subagentParentMessageRetained,
    subagentMessageRetained: report.subagentMessageRetained,
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
  return /^(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:completion|stop)-(?:receipt\.json|timeline\.html)|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-worktree-setup-receipt\.json|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:focused-agent-runtime|lint)\.log)$/.test(name);
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
  ws.on("error", () => failSocket(ws, state, pending, socketFailure("The WebSocket connection failed", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry inspect or live.")));
  ws.on("close", () => {
    if (!state.closing) failSocket(ws, state, pending, socketFailure("The WebSocket closed unexpectedly", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry inspect or live."));
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
    entry.reject(actionable(`RPC ${entry.method} failed (${String(message.error.code ?? "UNKNOWN")})`, "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry the command."));
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
      const error = socketFailure("The WebSocket did not connect within 15 seconds", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry inspect or live.");
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
    return Promise.reject(socketFailure("The WebSocket is not open", "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry the command."));
  }
  const id = `verify-${++state.counter}`;
  const timeout = deadline === undefined ? HEALTH_TIMEOUT_MS : Math.max(1, deadline - Date.now());
  const timeoutDescription = deadline === undefined ? "within 15 seconds" : "before the live deadline";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(actionable(`RPC ${method} did not respond ${timeoutDescription}`, "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime diagnostics, then retry the command."));
    }, timeout);
    pending.set(id, { method, resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      reject(socketFailure(`RPC ${method} could not be sent`, "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime health, then retry the command."));
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
  return actionable(condition, "Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime --help.");
}

function actionable(condition, nextAction) {
  return new Error(`Condition: ${condition}. Next action: ${nextAction}`);
}

function safeError(error) {
  const message = safeText(error instanceof Error ? error.message : String(error));
  return message.startsWith("Condition:")
    ? message
    : `Condition: ${message} Next action: Run bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime --help.`;
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

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    printJson({ ok: false, error: safeError(error) });
    process.exitCode = 1;
  }
}
