#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { probeCdpVersion } from "../../../../.agents/skills/electorn-live-testing/scripts/start-electron.mjs";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../../../");
const DATABASE_PATH = NodePath.join(REPO_ROOT, ".dev", "electron-live-testing", "runtime", "db", "app.sqlite");
const ELECTRON_SESSION_PATH = NodePath.join(REPO_ROOT, ".dev", "electron-live-testing.json");
const FIXTURE_WORKSPACE_PATH = NodePath.join(REPO_ROOT, ".dev", "fixture-repo");
const STATE_PATH = NodePath.join(REPO_ROOT, ".dev", "verification", "selected-text-comments-fixture.json");
const FIXTURE_THREAD_ID = "mcode-verification-selected-text-thread";
const FIXTURE_MESSAGE_ID = "mcode-verification-selected-text-message";
const FIXTURE_TITLE = "Selected text comments verification";
const FIXTURE_MESSAGE_CONTENT = [
  ...Array.from({ length: 24 }, (_, index) => `Verification context before the selected phrase ${index + 1}.`),
  [
    "It includes:",
    "",
    "- Component, sequence, and state UML diagrams",
    "- Select this verification phrase",
    "- TTL, timing, and retry rules",
  ].join("\n"),
  ...Array.from({ length: 24 }, (_, index) => `Verification context after the selected phrase ${index + 1}.`),
].join("\n\n");
const FIXTURE_SKILL_DIRECTORY = NodePath.join(FIXTURE_WORKSPACE_PATH, ".claude", "skills", "verification-comment");
const FIXTURE_SKILL_PATH = NodePath.join(FIXTURE_SKILL_DIRECTORY, "SKILL.md");
const FIXTURE_SKILL_CONTENT = `---
name: verification-comment
description: Add a deterministic selected-text verification comment.
---

# Verification comment

Use this fixture skill only to verify selected-text comment slash insertion.
`;
const MAX_WORKSPACE_ID_LENGTH = 200;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/** Enforces the Electron session state required before a fixture operation. */
export function assertElectronSessionState(command, healthy) {
  if (healthy) throw new Error(`${command} requires a stopped Electron session`);
}

/** Rejects a fixture state path outside this worktree's verification directory. */
export function assertOwnedStatePath(root, statePath) {
  const expected = NodePath.join(NodePath.resolve(root), ".dev", "verification", "selected-text-comments-fixture.json");
  if (NodePath.resolve(statePath) !== expected) throw new Error("Fixture state path is outside the worktree verification directory");
}

/** Rejects fixture skill paths outside the owned disposable workspace. */
export function assertOwnedSkillPath(root, skillPath) {
  const expected = NodePath.join(NodePath.resolve(root), ".dev", "fixture-repo", ".claude", "skills", "verification-comment", "SKILL.md");
  if (NodePath.resolve(skillPath) !== expected) throw new Error("Fixture skill path is outside the disposable workspace");
}

/** Rejects cleanup when the fixture skill was replaced with other content. */
export function assertOwnedSkillContent(content) {
  if (content !== FIXTURE_SKILL_CONTENT) throw new Error("Fixture skill content is not owned by this verifier");
}

function isValidWorkspaceId(workspaceId) {
  return typeof workspaceId === "string"
    && workspaceId.length > 0
    && workspaceId.length <= MAX_WORKSPACE_ID_LENGTH
    && SAFE_IDENTIFIER.test(workspaceId);
}

/** Validates the persisted identifiers needed to remove one fixture thread. */
export function assertFixtureState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Fixture state must be an object");
  const keys = Object.keys(state).sort();
  if (keys.join(",") !== "messageId,threadId,workspaceId") throw new Error("Fixture state has an unexpected shape");
  if (!isValidWorkspaceId(state.workspaceId)) {
    throw new Error("Fixture state workspace ID is invalid");
  }
  if (state.threadId !== FIXTURE_THREAD_ID) throw new Error("Fixture state thread ID is not owned by this fixture");
  if (state.messageId !== FIXTURE_MESSAGE_ID) throw new Error("Fixture state message ID is not owned by this fixture");
  return state;
}

/** Rejects cleanup when stored rows do not belong to this fixture. */
export function assertCleanupIdentity(state, thread, message) {
  assertFixtureState(state);
  if (thread && (thread.workspace_id !== state.workspaceId || thread.title !== FIXTURE_TITLE)) {
    throw new Error("Fixture thread does not match the recorded workspace and title");
  }
  if (message && (message.id !== FIXTURE_MESSAGE_ID || message.thread_id !== FIXTURE_THREAD_ID)) {
    throw new Error("Fixture message does not match the recorded thread");
  }
}

function normalizePath(value) {
  const resolved = NodePath.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isValidElectronSessionRecord(record) {
  return Boolean(record)
    && record.status === "running"
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && Number.isSafeInteger(record.debugPort)
    && record.debugPort >= 1
    && record.debugPort <= 65_535
    && typeof record.repoRoot === "string"
    && normalizePath(record.repoRoot) === normalizePath(REPO_ROOT);
}

function readElectronSession() {
  const record = JSON.parse(NodeFS.readFileSync(ELECTRON_SESSION_PATH, "utf8"));
  const endpoint = parseLoopbackEndpoint(record?.endpoint);
  if (
    !isValidElectronSessionRecord(record)
    || !endpoint
    || Number(endpoint.port) !== record.debugPort
  ) {
    throw new Error("Electron live session record is invalid");
  }
  return record;
}

function isLoopbackEndpoint(endpoint) {
  return endpoint.protocol === "http:"
    && (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]")
    && !endpoint.username
    && !endpoint.password
    && endpoint.pathname === "/"
    && !endpoint.search
    && !endpoint.hash
    && Boolean(endpoint.port);
}

function parseLoopbackEndpoint(value) {
  if (typeof value !== "string") return null;
  try {
    const endpoint = new URL(value);
    return isLoopbackEndpoint(endpoint) ? endpoint : null;
  } catch {
    return null;
  }
}

async function isElectronSessionHealthy() {
  if (!NodeFS.existsSync(ELECTRON_SESSION_PATH)) return false;
  const session = readElectronSession();
  return probeCdpVersion(session.endpoint);
}

function openDatabase() {
  const database = new Database(DATABASE_PATH);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function findFixtureWorkspace(database) {
  const workspace = database.query(
    "SELECT id, path FROM workspaces WHERE path = ? AND deleted_at IS NULL",
  ).get(FIXTURE_WORKSPACE_PATH);
  if (
    !workspace
    || typeof workspace.id !== "string"
    || typeof workspace.path !== "string"
    || normalizePath(workspace.path) !== normalizePath(FIXTURE_WORKSPACE_PATH)
  ) {
    throw new Error("The built-in fixture workspace is unavailable");
  }
  return workspace;
}

function createFixtureState(workspaceId) {
  return assertFixtureState({
    workspaceId,
    threadId: FIXTURE_THREAD_ID,
    messageId: FIXTURE_MESSAGE_ID,
  });
}

function insertFixtureRows(database, state) {
  database.transaction(() => {
    database.query(
      "INSERT INTO threads (id, workspace_id, title, status, mode, branch, checkout_state, base_branch, worktree_managed, provider) VALUES (?, ?, ?, 'active', 'direct', 'main', 'named', NULL, 1, 'claude')",
    ).run(state.threadId, state.workspaceId, FIXTURE_TITLE);
    database.query(
      "INSERT INTO messages (id, thread_id, role, content, sequence, outcome) VALUES (?, ?, 'assistant', ?, 1, 'completed')",
    ).run(state.messageId, state.threadId, FIXTURE_MESSAGE_CONTENT);
  })();
}

function writeFixtureState(state) {
  NodeFS.mkdirSync(NodePath.dirname(STATE_PATH), { recursive: true });
  NodeFS.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function writeFixtureSkill() {
  assertOwnedSkillPath(REPO_ROOT, FIXTURE_SKILL_PATH);
  if (NodeFS.existsSync(FIXTURE_SKILL_PATH)) {
    assertOwnedSkillContent(NodeFS.readFileSync(FIXTURE_SKILL_PATH, "utf8"));
    return;
  }
  NodeFS.mkdirSync(FIXTURE_SKILL_DIRECTORY, { recursive: true });
  NodeFS.writeFileSync(FIXTURE_SKILL_PATH, FIXTURE_SKILL_CONTENT, { encoding: "utf8", flag: "wx" });
}

function removeFixtureSkill() {
  assertOwnedSkillPath(REPO_ROOT, FIXTURE_SKILL_PATH);
  if (!NodeFS.existsSync(FIXTURE_SKILL_PATH)) return;
  assertOwnedSkillContent(NodeFS.readFileSync(FIXTURE_SKILL_PATH, "utf8"));
  NodeFS.unlinkSync(FIXTURE_SKILL_PATH);
  if (NodeFS.existsSync(FIXTURE_SKILL_DIRECTORY) && NodeFS.readdirSync(FIXTURE_SKILL_DIRECTORY).length === 0) {
    NodeFS.rmdirSync(FIXTURE_SKILL_DIRECTORY);
  }
}

function deleteCreatedThread(database, state) {
  const thread = database.query(
    "SELECT workspace_id, title FROM threads WHERE id = ?",
  ).get(state.threadId);
  assertCleanupIdentity(state, thread, undefined);
  if (!thread) return;
  database.query(
    "DELETE FROM threads WHERE id = ? AND workspace_id = ? AND title = ?",
  ).run(state.threadId, state.workspaceId, FIXTURE_TITLE);
}

function rollBackCreatedThread(database, state) {
  try {
    deleteCreatedThread(database, state);
  } catch {
    // Keep the setup error when ownership validation prevents rollback.
  }
}

async function setupFixture() {
  if (NodeFS.existsSync(STATE_PATH)) throw new Error("Fixture state already exists. Run cleanup before setup.");
  assertElectronSessionState("setup", await isElectronSessionHealthy());
  if (!NodeFS.existsSync(DATABASE_PATH)) {
    throw new Error("Electron's isolated database is missing. Start and stop Electron once to initialize it.");
  }

  const database = openDatabase();
  let state;
  try {
    const workspace = findFixtureWorkspace(database);
    state = createFixtureState(workspace.id);
    writeFixtureSkill();
    insertFixtureRows(database, state);
    writeFixtureState(state);
  } catch (error) {
    if (state) {
      rollBackCreatedThread(database, state);
      NodeFS.rmSync(STATE_PATH, { force: true });
      removeFixtureSkill();
    }
    throw error;
  } finally {
    database.close();
  }
}

function readFixtureState() {
  return assertFixtureState(JSON.parse(NodeFS.readFileSync(STATE_PATH, "utf8")));
}

function removeFixtureRows(database, state) {
  database.transaction(() => {
    const thread = database.query(
      "SELECT workspace_id, title FROM threads WHERE id = ?",
    ).get(state.threadId);
    const message = database.query(
      "SELECT id, thread_id FROM messages WHERE id = ?",
    ).get(state.messageId);
    assertCleanupIdentity(state, thread, message);
    if (message) database.query("DELETE FROM messages WHERE id = ? AND thread_id = ?").run(state.messageId, state.threadId);
    if (thread) {
      database.query(
        "DELETE FROM threads WHERE id = ? AND workspace_id = ? AND title = ?",
      ).run(state.threadId, state.workspaceId, FIXTURE_TITLE);
    }
  })();
}

async function cleanupFixture() {
  assertElectronSessionState("cleanup", await isElectronSessionHealthy());
  const state = readFixtureState();
  assertOwnedSkillPath(REPO_ROOT, FIXTURE_SKILL_PATH);
  assertOwnedSkillContent(NodeFS.readFileSync(FIXTURE_SKILL_PATH, "utf8"));
  const database = openDatabase();
  try {
    removeFixtureRows(database, state);
  } finally {
    database.close();
  }
  removeFixtureSkill();
  NodeFS.rmSync(STATE_PATH);
}

async function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "help" || !command) {
    console.log("Usage: bun selected-text-comments-fixture.mjs setup|cleanup|--help");
    return;
  }
  if (command !== "setup" && command !== "cleanup") throw new Error(`Unknown command: ${command}`);

  assertOwnedStatePath(REPO_ROOT, STATE_PATH);
  if (command === "setup") await setupFixture();
  else await cleanupFixture();
}

if (import.meta.main) await main();
