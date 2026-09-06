#!/usr/bin/env node
/** Controlled Codex app-server fixture for protocol-notice desktop verification. */
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const FIXTURE_VERSION = "99.0.0";
export const FIXTURE_NATIVE_THREAD_ID = "fixture-native-thread";
export const FIXTURE_NATIVE_TURN_ID = "fixture-native-turn";
export const FIXTURE_ASSISTANT_TEXT = "Fixture notice turn completed.";
export const FIXTURE_TURN_DELAY_MS = 500;

export const FIXTURE_NOTICES = Object.freeze([
  {
    method: "configWarning",
    params: {
      summary: "Fixture configuration diagnostic.",
      details: "Fixture configuration detail.",
      path: "C:/mcode-fixture/config.toml",
      range: { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } },
    },
  },
  {
    method: "guardianWarning",
    params: { threadId: FIXTURE_NATIVE_THREAD_ID, message: "Fixture guardian security warning." },
  },
  {
    method: "warning",
    params: { threadId: FIXTURE_NATIVE_THREAD_ID, message: "Fixture plain warning." },
  },
  {
    method: "model/rerouted",
    params: {
      threadId: FIXTURE_NATIVE_THREAD_ID,
      turnId: FIXTURE_NATIVE_TURN_ID,
      fromModel: "fixture-source",
      toModel: "fixture-safe",
      reason: "highRiskCyberActivity",
    },
  },
  {
    method: "modelProvider/authRecoveryCompleted",
    params: {
      threadId: FIXTURE_NATIVE_THREAD_ID,
      turnId: FIXTURE_NATIVE_TURN_ID,
      provider: "fixture-provider",
      message: "Fixture authentication recovered.",
    },
  },
]);

/** Parses the small CLI contract used by the generated Windows wrapper. */
export function parseFixtureArguments(argv) {
  if (argv.length === 1 && argv[0] === "--version") return { command: "version" };
  if (argv[0] !== "app-server") throw new Error("Usage: codex-protocol-notices-fixture.mjs <--version|app-server [-c key=value]...>");
  for (let index = 1; index < argv.length; index += 2) {
    if (argv[index] !== "-c" || typeof argv[index + 1] !== "string") {
      throw new Error("app-server accepts only complete -c key=value overrides");
    }
  }
  return { command: "app-server" };
}

/** Runs the narrow JSON-RPC surface that the production Codex adapter needs. */
export function runFixtureAppServer({ input = process.stdin, output = process.stdout } = {}) {
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  let turnStarted = false;
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || message.id === undefined || typeof message.method !== "string") return;
    if (message.method === "thread/start") {
      respond(message.id, { thread: { id: FIXTURE_NATIVE_THREAD_ID } });
      return;
    }
    if (message.method !== "turn/start") {
      respond(message.id, {});
      return;
    }
    if (turnStarted) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Fixture supports one turn per process." } });
      return;
    }
    turnStarted = true;
    respond(message.id, { turn: { id: FIXTURE_NATIVE_TURN_ID } });
    setTimeout(() => emitFixtureTurn(notify), FIXTURE_TURN_DELAY_MS);
  });
}

function emitFixtureTurn(notify) {
  notify("turn/started", {
    threadId: FIXTURE_NATIVE_THREAD_ID,
    turn: { id: FIXTURE_NATIVE_TURN_ID, items: [], status: "inProgress", error: null },
  });
  for (const notice of FIXTURE_NOTICES) {
    notify(notice.method, notice.params);
    if (notice.method === "configWarning" || notice.method === "model/rerouted") {
      notify(notice.method, notice.params);
    }
  }
  notify("item/completed", {
    threadId: FIXTURE_NATIVE_THREAD_ID,
    turnId: FIXTURE_NATIVE_TURN_ID,
    item: {
      id: "fixture-assistant-message",
      type: "agentMessage",
      text: FIXTURE_ASSISTANT_TEXT,
      phase: "final_answer",
      memoryCitation: null,
    },
  });
  notify("turn/completed", {
    threadId: FIXTURE_NATIVE_THREAD_ID,
    turn: { id: FIXTURE_NATIVE_TURN_ID, items: [], status: "completed", error: null },
  });
}

function main() {
  const parsed = parseFixtureArguments(process.argv.slice(2));
  if (parsed.command === "version") {
    process.stdout.write(`codex ${FIXTURE_VERSION}\n`);
    return;
  }
  runFixtureAppServer();
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
