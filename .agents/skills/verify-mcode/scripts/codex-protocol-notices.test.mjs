import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

import { parseCodexProtocolNoticeArguments, renderFixtureWrapper } from "./codex-protocol-notices.mjs";
import { FIXTURE_QUEUE_PROMPT_MARKER } from "./codex-protocol-notices-fixture.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixturePath = NodePath.join(scriptDirectory, "codex-protocol-notices-fixture.mjs");
const controlPath = NodePath.join(scriptDirectory, "codex-protocol-notices.mjs");

NodeTest.test("fixture emits the exact bounded native notice sequence for one turn", async () => {
  const server = startFixture(["app-server"]);
  try {
    NodeAssertStrict.deepEqual(await server.request(1, "initialize", {}), {});
    NodeAssertStrict.deepEqual(await server.request(2, "model/list", {}), {});
    NodeAssertStrict.deepEqual(await server.request(3, "thread/start", {}), { thread: { id: "fixture-native-thread" } });
    NodeAssertStrict.deepEqual(await server.request(4, "turn/start", { threadId: "fixture-native-thread", input: [] }), { turn: { id: "fixture-native-turn" } });
    await delay(250);
    NodeAssertStrict.equal(server.notificationCount(), 0);

    const notices = await server.notifications(14);
    NodeAssertStrict.deepEqual(notices, [
      { method: "turn/started", params: { threadId: "fixture-native-thread", turn: { id: "fixture-native-turn", items: [], status: "inProgress", error: null } } },
      { method: "configWarning", params: { summary: "Fixture configuration diagnostic.", details: "Fixture configuration detail.", path: "C:/mcode-fixture/config.toml", range: { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } } } },
      { method: "configWarning", params: { summary: "Fixture configuration diagnostic.", details: "Fixture configuration detail.", path: "C:/mcode-fixture/config.toml", range: { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } } } },
      { method: "guardianWarning", params: { threadId: "fixture-native-thread", message: "Fixture guardian security warning." } },
      { method: "warning", params: { threadId: "fixture-native-thread", message: "Fixture plain warning." } },
      { method: "model/rerouted", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", fromModel: "fixture-source", toModel: "fixture-safe", reason: "highRiskCyberActivity" } },
      { method: "model/rerouted", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", fromModel: "fixture-source", toModel: "fixture-safe", reason: "highRiskCyberActivity" } },
      { method: "modelProvider/authRecoveryCompleted", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", provider: "fixture-provider", message: "Fixture authentication recovered." } },
      { method: "item/started", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", item: { id: "fixture-sleep", type: "sleep" } } },
      { method: "item/completed", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", item: { id: "fixture-sleep", type: "sleep" } } },
      { method: "item/started", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", item: { id: "fixture-unknown", type: "fixtureUnknownItem" } } },
      { method: "item/completed", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", item: { id: "fixture-unknown", type: "fixtureUnknownItem" } } },
      { method: "item/completed", params: { threadId: "fixture-native-thread", turnId: "fixture-native-turn", item: { id: "fixture-assistant-message", type: "agentMessage", text: "Fixture notice turn completed.", phase: "final_answer", memoryCitation: null } } },
      { method: "turn/completed", params: { threadId: "fixture-native-thread", turn: { id: "fixture-native-turn", items: [], status: "completed", error: null } } },
    ]);
    await NodeAssertStrict.rejects(
      server.request(5, "turn/start", { threadId: "fixture-native-thread", input: [] }),
      (error) => error instanceof Error && error.code === -32000,
    );
  } finally {
    server.stop();
  }
});

NodeTest.test("fixture keeps the queue-overlay verification turn running after its notices arrive", async () => {
  const server = startFixture(["app-server"]);
  try {
    await server.request(1, "initialize", {});
    await server.request(2, "thread/start", {});
    await server.request(3, "turn/start", {
      threadId: "fixture-native-thread",
      input: [{ type: "text", text: FIXTURE_QUEUE_PROMPT_MARKER }],
    });
    const notices = await server.notifications(12);
    NodeAssertStrict.equal(notices.at(-1)?.method, "item/completed");
    NodeAssertStrict.equal(server.notificationCount(), 12);
  } finally {
    server.stop();
  }
});

NodeTest.test("fixture reports its preflight version and rejects malformed commands", () => {
  const version = NodeChildProcess.spawnSync(process.execPath, [fixturePath, "--version"], { encoding: "utf8" });
  NodeAssertStrict.equal(version.status, 0);
  NodeAssertStrict.equal(version.stdout, "codex 99.0.0\n");

  const malformed = NodeChildProcess.spawnSync(process.execPath, [fixturePath, "app-server", "-c"], { encoding: "utf8" });
  NodeAssertStrict.notEqual(malformed.status, 0);
  NodeAssertStrict.equal(malformed.stdout, "");
});

NodeTest.test("control CLI rejects invalid commands and keeps the wrapper command quoted", () => {
  NodeAssertStrict.throws(() => parseCodexProtocolNoticeArguments(["unknown"]), Error);
  NodeAssertStrict.throws(() => parseCodexProtocolNoticeArguments(["cleanup"]), Error);
  NodeAssertStrict.equal(
    renderFixtureWrapper("C:\\tools\\bun.exe", "C:\\repo\\fixture.mjs"),
    "@echo off\r\n\"C:\\tools\\bun.exe\" \"C:\\repo\\fixture.mjs\" %*\r\n",
  );
  NodeAssertStrict.throws(() => renderFixtureWrapper("C:\\tools\\bun.exe", "C:\\repo\\%fixture%.mjs"), Error);

  const invalid = NodeChildProcess.spawnSync(process.execPath, [controlPath, "invalid"], { encoding: "utf8" });
  NodeAssertStrict.notEqual(invalid.status, 0);
  NodeAssertStrict.equal(invalid.stdout, "");
});

function startFixture(args) {
  const child = NodeChildProcess.spawn(process.execPath, [fixturePath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const notificationRows = [];
  const waiters = [];
  const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const row = JSON.parse(line);
    if (row.id !== undefined) {
      const deferred = pending.get(row.id);
      if (!deferred) throw new Error(`Unexpected response ID ${String(row.id)}`);
      pending.delete(row.id);
      clearTimeout(deferred.timeout);
      if (row.error) {
        const error = new Error(String(row.error.message));
        error.code = row.error.code;
        deferred.reject(error);
        return;
      }
      deferred.resolve(row.result);
      return;
    }
    notificationRows.push({ method: row.method, params: row.params });
    const waiter = waiters[0];
    if (waiter && notificationRows.length >= waiter.count) {
      waiters.shift();
      clearTimeout(waiter.timeout);
      waiter.resolve(notificationRows.slice(0, waiter.count));
    }
  });
  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for fixture response ${String(id)}`));
        }, 5_000);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notifications(count) {
      if (notificationRows.length >= count) return Promise.resolve(notificationRows.slice(0, count));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${count} fixture notifications`)), 5_000);
        waiters.push({ count, resolve, timeout });
      });
    },
    notificationCount() {
      return notificationRows.length;
    },
    stop() {
      child.kill();
      lines.close();
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
