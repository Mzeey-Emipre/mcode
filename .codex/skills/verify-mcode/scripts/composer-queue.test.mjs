import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, test } from "bun:test";

import {
  parseComposerQueueArguments,
  prepareCursorForVerifier,
  prepareProviderForProof,
  ProviderProofError,
  providerMatrix,
  redactComposerQueueReceipt,
  resolveLiveAppPage,
  runProviderMatrix,
  cleanupOwnedRun,
  cleanupInterruptedQueueRun,
  cursorSettingEvidence,
  cursorNeedsProofLocalEnablement,
  assertQueueRows,
  evidenceFile,
  ensureFixtureWorkspace,
  finishInterruptedCleanup,
  finishNavigationRepro,
  isStoppedElectronSession,
  listKnownReceipts,
  liveQueueSeamObserved,
  removeActiveRun,
  restoreCursorForVerifier,
  restoreCursorForTerminalPath,
  queueMessages,
  queuePrompt,
  rootPrompt,
  openQueueSocket,
  openInterruptedQueueSocket,
  requireSameQueueSocket,
  resolveEvidenceDirectory,
  selectProviderModelInUi,
  summarizeQueueProviderEvents,
  subscribeBeforeRootSubmission,
  verifyQueueTurnEvidence,
  verifyQueueProviderEvidence,
  validateOwnedElectronRuntimeDirectory,
  waitForBounded,
  startRootTurn,
  waitForRootTurnToRun,
  waitForRootCompletionAndAStart,
  writeActiveRun,
} from "./composer-queue.mjs";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../../..");
const EVIDENCE_DIRECTORY = NodePath.join(REPO_ROOT, ".dev", "verification", "composer-queue");
const FIXTURE_PATH = NodePath.join(REPO_ROOT, ".dev", "fixture-repo");
const RUN_ID = "2026-09-03T01-00-00-000Z-00000000-0000-4000-8000-000000000000";

function ownedRecord(overrides = {}) {
  return {
    cursorEnabledByVerifier: false,
    cursorOriginalEnabled: null,
    cursorRestorePending: false,
    id: `${RUN_ID}-codex`,
    marker: "00000000",
    model: "gpt-5.4",
    ownsWorkspace: false,
    electronRuntimeDirectory: null,
    provider: "codex",
    sessionFileName: "electron-composer-queue-codex-deadbeef.json",
    threadId: "thread-owned",
    workspaceCreationPending: false,
    workspaceId: "workspace-owned",
    ...overrides,
  };
}

function cursorSettingsSocket(initialEnabled, options = {}) {
  let enabled = initialEnabled;
  let closed = false;
  const calls = [];
  const updates = [];
  const settings = () => ({ provider: { enabled: { codex: true, cursor: enabled } } });
  const update = (params) => {
    updates.push(params);
    const requested = params?.provider?.enabled?.cursor;
    if (requested === true && options.failEnable) throw new Error("settings.update enable failed");
    if (requested === true && options.loseEnableResponse) {
      enabled = true;
      throw new Error("settings.update response was lost");
    }
    if (requested === false && options.failRestore) throw new Error("settings.update restore failed");
    enabled = requested;
    return settings();
  };
  return {
    get closed() { return closed; },
    get enabled() { return enabled; },
    calls,
    updates,
    socket: {
      close: async () => { closed = true; },
      rpc: async (method, params) => {
        calls.push(method);
        if (method === "settings.get") return settings();
        if (method === "settings.update") return update(params);
        if (method === "providers.listAvailability" && options.providerReady) {
          return [{ cli: { status: "found" }, comingSoon: false, enabled: true, hasAdapter: true, id: "cursor" }];
        }
        if (method === "provider.listModels" && options.providerReady) {
          return [{ id: "cursor-small", name: "Cursor Small" }];
        }
        throw new Error(`Unexpected RPC ${method}`);
      },
    },
  };
}

function separateCursorSettingsStores(worktreeEnabled, electronEnabled, options = {}) {
  return {
    electron: cursorSettingsSocket(electronEnabled, options.electron),
    worktree: cursorSettingsSocket(worktreeEnabled, options.worktree),
  };
}

test("defaults Codex to gpt-5.6-luna but requires Cursor and proof confirmations", () => {
  expect(parseComposerQueueArguments([
    "health",
    "--cursor-model", "cursor-small",
  ])).toEqual({
    allowEnableCursor: false,
    codexModel: "gpt-5.6-luna",
    command: "health",
    confirmCleanup: false,
    confirmProviderCalls: false,
    cursorModel: "cursor-small",
  });

  expect(() => parseComposerQueueArguments([
    "proof",
    "--codex-model", "gpt-5.4",
    "--cursor-model", "cursor-small",
    "--confirm-provider-calls",
  ])).toThrow("requires --confirm-cleanup");

  expect(parseComposerQueueArguments([
    "proof",
    "--cursor-model", "cursor-small",
    "--confirm-provider-calls",
    "--confirm-cleanup",
  ])).toMatchObject({ codexModel: "gpt-5.6-luna" });

  expect(parseComposerQueueArguments([
    "proof",
    "--codex-model", "gpt-5.4",
    "--cursor-model", "cursor-small",
    "--confirm-provider-calls",
    "--confirm-cleanup",
  ])).toEqual({
    allowEnableCursor: false,
    command: "proof",
    codexModel: "gpt-5.4",
    confirmCleanup: true,
    confirmProviderCalls: true,
    cursorModel: "cursor-small",
  });

  expect(parseComposerQueueArguments([
    "health",
    "--codex-model", "gpt-5.4",
    "--cursor-model", "cursor-small",
    "--allow-enable-cursor",
  ])).toMatchObject({ allowEnableCursor: true });

  expect(() => parseComposerQueueArguments(["health"])).toThrow("require --cursor-model");
});

test("temporarily enables and restores Cursor through the Electron-local settings store", async () => {
  const stores = separateCursorSettingsStores(false, false);
  const record = ownedRecord({
    electronRuntimeDirectory: "electron-local-runtime",
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });
  const persisted = [];
  const persist = () => persisted.push(structuredClone(record));

  await prepareCursorForVerifier(stores.electron.socket, record, true, persist);
  expect(stores.worktree.enabled).toBe(false);
  expect(stores.worktree.updates).toEqual([]);
  expect(stores.electron.enabled).toBe(true);
  await restoreCursorForVerifier(stores.electron.socket, record, persist);

  expect(stores.electron.updates).toEqual([
    { provider: { enabled: { cursor: true } } },
    { provider: { enabled: { cursor: false } } },
  ]);
  expect(persisted[0]).toMatchObject({
    cursorEnabledByVerifier: false,
    cursorOriginalEnabled: false,
    cursorRestorePending: true,
    electronRuntimeDirectory: "electron-local-runtime",
  });
  expect(record).toMatchObject({
    cursorEnabledByVerifier: true,
    cursorOriginalEnabled: false,
    cursorRestorePending: false,
  });
  expect(stores.electron.enabled).toBe(false);
  expect(stores.worktree.enabled).toBe(false);
});

test("proof preparation uses the Electron-local queue socket for Cursor setting, readiness, and restoration", async () => {
  const stores = separateCursorSettingsStores(false, false, { electron: { providerReady: true } });
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({
    electronRuntimeDirectory: "electron-local-runtime",
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
    threadId: null,
    workspaceId: null,
  });
  try {
    writeActiveRun(evidence, record);
    const queueSocket = await openQueueSocket(async () => stores.electron.socket, record, { events: [] });
    const readiness = await prepareProviderForProof(
      queueSocket,
      { model: "cursor-small", provider: "cursor" },
      { allowEnableCursor: true },
      record,
      () => writeActiveRun(evidence, record),
    );
    const restorationFailure = await restoreCursorForTerminalPath(evidence, record, queueSocket);

    expect(queueSocket).toBe(stores.electron.socket);
    expect(readiness).toEqual({ model: "cursor-small", modelLabel: "Cursor Small", provider: "cursor", ready: true });
    expect(restorationFailure).toBeNull();
    expect(stores.electron.calls).toEqual([
      "settings.get",
      "settings.update",
      "providers.listAvailability",
      "provider.listModels",
      "settings.update",
    ]);
    expect(stores.worktree.calls).toEqual([]);
    expect(stores.worktree.updates).toEqual([]);
    expect(stores.electron.enabled).toBe(false);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("health leaves a disabled worktree Cursor setting unchanged when proof-local consent is present", async () => {
  const stores = separateCursorSettingsStores(false, false);

  await expect(cursorNeedsProofLocalEnablement(stores.worktree.socket, true)).resolves.toBe(true);
  expect(stores.worktree.enabled).toBe(false);
  expect(stores.worktree.updates).toEqual([]);
  await expect(cursorNeedsProofLocalEnablement(stores.worktree.socket, false))
    .rejects.toThrow("--allow-enable-cursor");
  expect(stores.worktree.updates).toEqual([]);
});

test("preserves an already enabled Cursor provider without mutating Codex", async () => {
  const stores = separateCursorSettingsStores(false, true);
  const record = ownedRecord({
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });

  await prepareCursorForVerifier(stores.electron.socket, record, true, () => undefined);
  await restoreCursorForVerifier(stores.electron.socket, record, () => undefined);

  expect(stores.electron.updates).toEqual([]);
  expect(stores.worktree.updates).toEqual([]);
  expect(record).toMatchObject({
    cursorOriginalEnabled: true,
    cursorRestorePending: false,
  });
});

test("restores the Electron-local Cursor state after a provider proof failure", async () => {
  const stores = separateCursorSettingsStores(false, false);
  const record = ownedRecord({
    electronRuntimeDirectory: "electron-local-runtime",
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });
  const persisted = [];
  const persist = () => persisted.push(structuredClone(record));

  await prepareCursorForVerifier(stores.electron.socket, record, true, persist);
  await restoreCursorForVerifier(stores.electron.socket, record, persist);

  expect(stores.electron.enabled).toBe(false);
  expect(stores.worktree.enabled).toBe(false);
  expect(stores.worktree.updates).toEqual([]);
  expect(record.cursorRestorePending).toBe(false);
});

test("retains and clears the restore handle when Cursor enablement fails", async () => {
  const service = cursorSettingsSocket(false, { failEnable: true });
  const record = ownedRecord({
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });
  const persisted = [];
  const persist = () => persisted.push(structuredClone(record));

  await expect(prepareCursorForVerifier(service.socket, record, true, persist))
    .rejects.toThrow("enable failed");
  expect(persisted).toEqual([expect.objectContaining({
    cursorEnabledByVerifier: false,
    cursorOriginalEnabled: false,
    cursorRestorePending: true,
  })]);

  await restoreCursorForVerifier(service.socket, record, persist);
  expect(service.updates).toEqual([
    { provider: { enabled: { cursor: true } } },
    { provider: { enabled: { cursor: false } } },
  ]);
  expect(record.cursorRestorePending).toBe(false);
  expect(service.enabled).toBe(false);
});

test("refuses to change a disabled Cursor provider without explicit consent", async () => {
  const service = cursorSettingsSocket(false);
  const record = ownedRecord({
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });

  await expect(prepareCursorForVerifier(service.socket, record, false, () => undefined))
    .rejects.toThrow("--allow-enable-cursor");
  expect(service.updates).toEqual([]);
  expect(record).toMatchObject({
    cursorOriginalEnabled: false,
    cursorRestorePending: false,
  });
});

test("retains Electron-local Cursor recovery after a lost enable response and restores it on interruption", async () => {
  const stores = separateCursorSettingsStores(false, false, { electron: { loseEnableResponse: true } });
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });
  const persist = () => writeActiveRun(evidence, record);
  try {
    await expect(prepareCursorForVerifier(stores.electron.socket, record, true, persist)).rejects
      .toThrow("response was lost");
    expect(JSON.parse(NodeFS.readFileSync(NodePath.join(evidence, "active-run.json"), "utf8"))).toMatchObject({
      cursorOriginalEnabled: false,
      cursorRestorePending: true,
    });
    await restoreCursorForVerifier(stores.electron.socket, record, persist);
    expect(stores.electron.updates).toEqual([
      { provider: { enabled: { cursor: true } } },
      { provider: { enabled: { cursor: false } } },
    ]);
    expect(stores.worktree.enabled).toBe(false);
    expect(stores.worktree.updates).toEqual([]);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("retains Electron-local restoration metadata when recovery restoration fails", async () => {
  const stores = separateCursorSettingsStores(false, true, { electron: { failRestore: true } });
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({
    cursorEnabledByVerifier: true,
    cursorOriginalEnabled: false,
    cursorRestorePending: true,
    electronRuntimeDirectory: "electron-local-runtime",
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
    threadId: null,
    workspaceId: null,
  });
  try {
    writeActiveRun(evidence, record);
    const failure = await cleanupInterruptedQueueRun(
      REPO_ROOT,
      evidence,
      record,
      async () => stores.electron.socket,
    );

    expect(failure).toContain("restore failed");
    expect(record.cursorRestorePending).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(evidence, "active-run.json"))).toBe(true);
    expect(stores.worktree.enabled).toBe(false);
    expect(stores.worktree.updates).toEqual([]);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("interrupted cleanup restores Cursor through the recorded Electron-local socket", async () => {
  const stores = separateCursorSettingsStores(false, true);
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({
    cursorEnabledByVerifier: true,
    cursorOriginalEnabled: false,
    cursorRestorePending: true,
    electronRuntimeDirectory: "electron-local-runtime",
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
    threadId: null,
    workspaceId: null,
  });
  try {
    writeActiveRun(evidence, record);
    const opened = [];
    const failure = await cleanupInterruptedQueueRun(
      REPO_ROOT,
      evidence,
      record,
      async (repoRoot, activeRecord) => {
        opened.push({ activeRecord, repoRoot });
        return stores.electron.socket;
      },
    );
    expect(failure).toBeNull();
    expect(opened).toEqual([{ activeRecord: record, repoRoot: REPO_ROOT }]);
    expect(stores.electron.enabled).toBe(false);
    expect(stores.electron.closed).toBe(true);
    expect(stores.worktree.enabled).toBe(false);
    expect(stores.worktree.updates).toEqual([]);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("exposes a provider-free Composer queue check", () => {
  expect(parseComposerQueueArguments(["check"])).toEqual({ command: "check" });
  expect(() => parseComposerQueueArguments(["check", "--confirm-cleanup"])).toThrow("check does not accept options");
});

test("builds one fixed provider journey for Codex and Cursor", () => {
  expect(providerMatrix({ codexModel: "gpt-5.4", cursorModel: "cursor-small" })).toEqual([
    { model: "gpt-5.4", provider: "codex" },
    { model: "cursor-small", provider: "cursor" },
  ]);
});

test("records a failed provider but still runs the other fixed matrix entry", async () => {
  const attempted = [];
  const results = await runProviderMatrix(
    providerMatrix({ codexModel: "gpt-5.4", cursorModel: "cursor-small" }),
    async (target) => {
      attempted.push(target.provider);
      if (target.provider === "codex") throw new ProviderProofError("Codex unavailable", "codex-receipt.json");
      return { model: target.model, provider: target.provider, receiptPath: "receipt.json", status: "passed" };
    },
  );

  expect(attempted).toEqual(["codex", "cursor"]);
  expect(results).toEqual([
    { failure: "Codex unavailable", model: "gpt-5.4", provider: "codex", receiptPath: "codex-receipt.json", status: "failed" },
    { model: "cursor-small", provider: "cursor", receiptPath: "receipt.json", status: "passed" },
  ]);
});

test("does not start the next provider when the prior cleanup record remains", async () => {
  const attempted = [];
  const results = await runProviderMatrix(
    providerMatrix({ codexModel: "gpt-5.4", cursorModel: "cursor-small" }),
    async (target) => {
      attempted.push(target.provider);
      const error = new ProviderProofError("owned cleanup failed", "codex-receipt.json");
      error.cleanupFailed = true;
      throw error;
    },
  );

  expect(attempted).toEqual(["codex"]);
  expect(results).toEqual([
    { failure: "owned cleanup failed", model: "gpt-5.4", provider: "codex", receiptPath: "codex-receipt.json", status: "failed" },
  ]);
});

test("uses one explicit deadline rather than retrying an unavailable queue state", async () => {
  let calls = 0;
  await expect(waitForBounded(async () => {
    calls += 1;
    return false;
  }, Date.now() - 1, "bounded wait expired")).rejects.toThrow("bounded wait expired");
  expect(calls).toBe(0);
});

test("fills a queued message only after the root turn exposes Stop agent", async () => {
  const operations = [];
  let content = "";
  const editor = {
    fill: async (value) => {
      content = value;
      operations.push(`fill:${value}`);
    },
    textContent: async () => {
      operations.push("read:composer");
      return content;
    },
  };
  const button = (name) => ({
    click: async () => {
      operations.push(`click:${name}`);
      if (name === "Send message" || name === "Queue message") content = "";
    },
    waitFor: async () => {
      operations.push(`wait:${name}`);
      if (name === "Queue message" && !content) throw new Error("Queue message requires composer content");
    },
  });
  const page = {
    getByRole: (_role, { name }) => button(name),
    getByTestId: () => ({ getByRole: () => editor }),
  };

  await expect(page.getByRole("button", { name: "Queue message" }).waitFor()).rejects
    .toThrow("Queue message requires composer content");

  await startRootTurn(page, { marker: "root" });
  await waitForRootTurnToRun(page);
  await queueMessages(page, ["A", "B"]);

  expect(operations[1]).toStartWith("fill:CQ-root-root ");
  expect(operations.slice(0, 1)).toEqual([
    "wait:Queue message",
  ]);
  expect(operations.slice(2)).toEqual([
    "click:Send message",
    "wait:Stop agent",
    "read:composer",
    "fill:A",
    "wait:Queue message",
    "click:Queue message",
    "fill:B",
    "wait:Queue message",
    "click:Queue message",
  ]);
});

test("accepts visible A admission when provider start events are absent", async () => {
  const record = { marker: "root", provider: "codex", threadId: "thread-owned" };
  const operations = [];
  const socket = {
    rpc: async (method) => {
      operations.push(`rpc:${method}`);
      return {
        messages: [
          { content: rootPrompt(record), role: "user" },
          { content: queuePrompt("A", record), role: "user" },
        ],
      };
    },
  };
  const page = {
    getByRole: (_role, { name }) => {
      if (name === "Queued messages") {
        return {
          getByRole: (_role, { name: actionName }) => {
            expect(actionName).toEqual(/^Remove queued message \d+$/);
            return {
              all: async () => [{
                locator: () => ({
                  innerText: async () => {
                    operations.push("read:queue");
                    return queuePrompt("B", record);
                  },
                }),
              }],
            };
          },
          waitFor: async () => undefined,
        };
      }
      throw new Error(`Unexpected role name ${name}`);
    },
    getByTestId: () => ({
      getByRole: () => ({
        isVisible: async () => {
          operations.push("read:stop");
          return true;
        },
      }),
    }),
  };

  const diagnostics = {};
  await waitForRootCompletionAndAStart(
    socket,
    page,
    record,
    Date.now() + 1_000,
    diagnostics,
    {
      events: [],
      subscribed: true,
      subscribedBeforeRoot: true,
    },
  );

  expect(operations).toEqual(["rpc:message.list", "read:queue", "read:stop"]);
  expect(diagnostics).toEqual({
    rootCompletion: {
      durable: {
        exactPromptCounts: { A: 1, B: 0, C: 0, root: 1 },
        unexpectedUserMessageCount: 0,
        userMessageCount: 2,
      },
      queueMatchesExpected: true,
      queueRowCount: 1,
      providerEvents: {
        aStartEventCount: 0,
        aStartedAfterRootTerminal: false,
        bStartEventCount: 0,
        bStartedAfterContinue: false,
        providerTerminalObserved: false,
        rootStartEventCount: 0,
        rootStarted: false,
        rootTerminalObserved: false,
        subscribed: true,
        subscribedBeforeRoot: true,
        terminalEventCount: 0,
        turnStartedEventCount: 0,
      },
      running: true,
    },
  });
});

test("requires exact durable prompts, FIFO rows, and running UI for each live queue seam", () => {
  const rootToA = {
    durable: {
      exactPromptCounts: { A: 1, B: 0, C: 0, root: 1 },
      unexpectedUserMessageCount: 0,
      userMessageCount: 2,
    },
    queueMatchesExpected: true,
    running: true,
  };
  const continueToB = {
    durable: {
      exactPromptCounts: { A: 1, B: 1, C: 0, root: 1 },
      unexpectedUserMessageCount: 0,
      userMessageCount: 3,
    },
    queueMatchesExpected: true,
    running: true,
  };

  expect(liveQueueSeamObserved(rootToA, ["root", "A"])).toBe(true);
  expect(liveQueueSeamObserved(continueToB, ["root", "A", "B"])).toBe(true);
  expect(liveQueueSeamObserved({
    ...rootToA,
    durable: { ...rootToA.durable, exactPromptCounts: { ...rootToA.durable.exactPromptCounts, A: 2 }, userMessageCount: 3 },
  }, ["root", "A"])).toBe(false);
  expect(liveQueueSeamObserved({ ...rootToA, queueMatchesExpected: false }, ["root", "A"])).toBe(false);
  expect(liveQueueSeamObserved({ ...continueToB, running: false }, ["root", "A", "B"])).toBe(false);
});

test("rejects queued rows that contain the expected markers but not the exact FIFO prompts", async () => {
  const rows = ["CQ-A-root altered", "CQ-B-root extra"];
  const page = {
    getByRole: () => ({
      getByRole: () => ({
        all: async () => rows.map((row) => ({ locator: () => ({ innerText: async () => row }) })),
      }),
      waitFor: async () => undefined,
    }),
  };

  await expect(assertQueueRows(page, ["CQ-A-root", "CQ-B-root"])).rejects
    .toThrow("did not exactly match");
});

test("derives FIFO queue rows from accessible remove actions and ignores DnD helper divs", async () => {
  const rows = ["CQ-A-root", "CQ-B-root"];
  const page = {
    getByRole: () => ({
      getByRole: (_role, { name }) => {
        expect(name).toEqual(/^Remove queued message \d+$/);
        return {
          all: async () => rows.map((row) => ({
            locator: (selector) => {
              expect(selector).toContain("ancestor::div");
              return { innerText: async () => row };
            },
          })),
        };
      },
      locator: () => ({ allTextContents: async () => ["DnD accessibility helper", ...rows] }),
      waitFor: async () => undefined,
    }),
  };

  await expect(assertQueueRows(page, rows)).resolves.toBeUndefined();
});

test("keeps an already selected provider model and verifies its final UI selection", async () => {
  const operations = [];
  let expanded = false;
  const page = {
    getByTestId: (id) => {
      if (id === "model-selector-trigger") return {
        click: async () => { expanded = !expanded; operations.push("trigger"); },
        getAttribute: async () => String(expanded),
      };
      if (id === "model-group-codex") {
        return {
          getAttribute: async () => "true",
          isDisabled: async () => false,
          waitFor: async () => operations.push("wait:provider"),
        };
      }
      if (id === "model-selector-panel-search") {
        return {
          fill: async (value) => operations.push(`search:${value}`),
          waitFor: async () => operations.push("wait:search"),
        };
      }
      throw new Error(`Unexpected test id ${id}`);
    },
    getByRole: (_role, { name }) => {
      if (name === "Model, selected") {
        return {
          getAttribute: async () => "true",
          isVisible: async () => true,
          waitFor: async () => operations.push("wait:selected"),
        };
      }
      throw new Error(`Unexpected model role ${name}`);
    },
  };

  await selectProviderModelInUi(page, { model: "model-id", modelLabel: "Model", provider: "codex" });

  expect(operations).toEqual([
    "trigger",
    "wait:provider",
    "wait:search",
    "search:Model",
    "wait:provider",
    "search:Model",
    "wait:selected",
    "trigger",
  ]);
});

test("selects an unselected model, then verifies the selected provider and model", async () => {
  const operations = [];
  let providerSelected = false;
  let modelSelected = false;
  let expanded = false;
  const page = {
    getByTestId: (id) => {
      if (id === "model-selector-trigger") return {
        click: async () => { expanded = !expanded; operations.push("trigger"); },
        getAttribute: async () => String(expanded),
      };
      if (id === "model-group-codex") {
        return {
          click: async () => { providerSelected = true; operations.push("select:provider"); },
          getAttribute: async () => providerSelected ? "true" : null,
          isDisabled: async () => false,
          waitFor: async () => operations.push("wait:provider"),
        };
      }
      if (id === "model-selector-panel-search") {
        return {
          fill: async (value) => operations.push(`search:${value}`),
          waitFor: async () => operations.push("wait:search"),
        };
      }
      throw new Error(`Unexpected test id ${id}`);
    },
    getByRole: (_role, { name }) => {
      if (name === "Model, selected") {
        return {
          getAttribute: async () => modelSelected ? "true" : null,
          isVisible: async () => modelSelected,
          waitFor: async () => operations.push("wait:selected"),
        };
      }
      if (name === "Select Model") {
        return {
          click: async () => { modelSelected = true; operations.push("select:model"); },
          waitFor: async () => operations.push("wait:candidate"),
        };
      }
      throw new Error(`Unexpected model role ${name}`);
    },
  };

  await selectProviderModelInUi(page, { model: "model-id", modelLabel: "Model", provider: "codex" });

  expect(operations).toContain("select:provider");
  expect(operations).toContain("select:model");
  expect(operations).toContain("wait:selected");
});

test("reacquires a replacement app page instead of reusing a closed navigation handle", () => {
  const closedPage = { isClosed: () => true, url: () => "http://127.0.0.1:41890/" };
  const livePage = { isClosed: () => false, url: () => "http://127.0.0.1:41890/" };
  const context = { pages: () => [closedPage, livePage] };

  expect(resolveLiveAppPage(context, closedPage, "http://127.0.0.1:41890/")).toBe(livePage);
  expect(() => resolveLiveAppPage({ pages: () => [closedPage] }, closedPage, "http://127.0.0.1:41890/"))
    .toThrow("No live Electron app page remained after navigation");
});

test("redacts provider payloads and prompt text from a retained receipt", () => {
  const receipt = redactComposerQueueReceipt({
    assistantText: "assistant output must not be retained",
    model: "gpt-5.4",
    prompt: "read README.md and return a marker",
    provider: "codex",
    diagnostics: {
      rootCompletion: {
        durable: {
          exactPromptCounts: { A: 1, B: 0, C: 0, root: 1 },
          unexpectedUserMessageCount: 0,
          userMessageCount: 2,
        },
        queueMatchesExpected: true,
        queueRowCount: 1,
        providerEvents: {
          aStartEventCount: 1,
          aStartedAfterRootTerminal: true,
          bStartEventCount: 0,
          bStartedAfterContinue: false,
          providerTerminalObserved: true,
          rootStartEventCount: 1,
          rootStarted: true,
          rootTerminalObserved: true,
          subscribed: true,
          subscribedBeforeRoot: true,
          terminalEventCount: 1,
          turnStartedEventCount: 2,
        },
        running: true,
      },
    },
    providerPayload: { opaque: "not-retained" },
    runId: "2026-09-03T01-00-00-000Z-00000000-0000-4000-8000-000000000000",
    steps: [{ name: "root-completed", passed: true }],
    threadId: "thread-owned",
    workspaceId: "workspace-owned",
  });

  expect(receipt).toEqual({
    diagnostics: {
      rootCompletion: {
        durable: {
          exactPromptCounts: { A: 1, B: 0, C: 0, root: 1 },
          unexpectedUserMessageCount: 0,
          userMessageCount: 2,
        },
        queueMatchesExpected: true,
        queueRowCount: 1,
        providerEvents: {
          aStartEventCount: 1,
          aStartedAfterRootTerminal: true,
          bStartEventCount: 0,
          bStartedAfterContinue: false,
          providerTerminalObserved: true,
          rootStartEventCount: 1,
          rootStarted: true,
          rootTerminalObserved: true,
          subscribed: true,
          subscribedBeforeRoot: true,
          terminalEventCount: 1,
          turnStartedEventCount: 2,
        },
        running: true,
      },
    },
    model: "gpt-5.4",
    provider: "codex",
    runId: "2026-09-03T01-00-00-000Z-00000000-0000-4000-8000-000000000000",
    steps: [{ name: "root-completed", passed: true }],
    threadId: "thread-owned",
    workspaceId: "workspace-owned",
  });
});

test("records only the temporary Cursor setting restoration result in a receipt", () => {
  const receipt = redactComposerQueueReceipt({
    cursorSettings: { originalEnabled: false, restoredBeforeCleanup: true },
    model: "cursor-small",
    provider: "cursor",
    runId: RUN_ID,
  });

  expect(receipt.cursorSettings).toEqual({ originalEnabled: false, restoredBeforeCleanup: true });
  expect(JSON.stringify(receipt)).not.toContain("settings.update");
});

test("does not claim Cursor restoration when consent did not attempt enablement", () => {
  const receipt = redactComposerQueueReceipt({
    cursorSettings: cursorSettingEvidence(ownedRecord({
      cursorOriginalEnabled: false,
      provider: "cursor",
    })),
    model: "cursor-small",
    provider: "cursor",
    runId: RUN_ID,
  });

  expect(receipt.cursorSettings).toBeUndefined();
});

test("deletes only a verified owned direct fixture thread and preserves receipt evidence", async () => {
  const temporaryEvidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-composer-queue-"));
  const receiptPath = NodePath.join(temporaryEvidence, "receipt.json");
  NodeFS.writeFileSync(receiptPath, "retained evidence", "utf8");
  const calls = [];
  let deleted = false;
  const socket = {
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (method === "workspace.list") return [{ id: "workspace-owned", path: FIXTURE_PATH }];
      if (method === "thread.list") return deleted ? [] : [{ id: "thread-owned", mode: "direct", workspace_id: "workspace-owned" }];
      if (method === "thread.delete") {
        deleted = true;
        return true;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  };

  try {
    await expect(cleanupOwnedRun(socket, REPO_ROOT, EVIDENCE_DIRECTORY, ownedRecord())).resolves.toEqual({
      deletedThread: true,
      stoppedWorkspace: false,
    });
    expect(calls).toContainEqual(["thread.delete", { cleanupWorktree: false, threadId: "thread-owned" }]);
    expect(NodeFS.existsSync(receiptPath)).toBe(true);
  } finally {
    NodeFS.rmSync(temporaryEvidence, { force: true, recursive: true });
  }
});

test("refuses cleanup when an owned record no longer names the fixture workspace", async () => {
  const socket = {
    rpc: async (method) => {
      if (method === "workspace.list") return [{ id: "workspace-owned", path: "C:/unrelated" }];
      throw new Error(`Unsafe RPC ${method}`);
    },
  };

  await expect(cleanupOwnedRun(socket, REPO_ROOT, EVIDENCE_DIRECTORY, ownedRecord())).rejects
    .toThrow("no longer matches this worktree fixture");
});

test("does not overwrite an interrupted active record", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const first = ownedRecord();
  const second = ownedRecord({
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });
  try {
    writeActiveRun(evidence, first);
    expect(() => writeActiveRun(evidence, second)).toThrow("still active");
    expect(JSON.parse(NodeFS.readFileSync(NodePath.join(evidence, "active-run.json"), "utf8"))).toEqual(first);
  } finally {
    removeActiveRun(evidence, first.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("retains recovery metadata when the workspace response is unavailable", async () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({ threadId: null });
  try {
    writeActiveRun(evidence, record);
    await expect(cleanupOwnedRun({ rpc: async () => undefined }, REPO_ROOT, evidence, record)).rejects
      .toThrow("workspace.list returned an invalid response");
    expect(NodeFS.existsSync(NodePath.join(evidence, "active-run.json"))).toBe(true);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("retains recovery metadata until both resource and Electron cleanup are verified", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord();
  try {
    writeActiveRun(evidence, record);
    expect(finishInterruptedCleanup(evidence, record, "thread still present", null)).toBe("thread still present");
    expect(NodeFS.existsSync(NodePath.join(evidence, "active-run.json"))).toBe(true);
    expect(finishInterruptedCleanup(evidence, record, null, null)).toBeNull();
    expect(NodeFS.existsSync(NodePath.join(evidence, "active-run.json"))).toBe(false);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("rejects a false workspace delete result instead of reporting cleanup success", async () => {
  let deletedThread = false;
  const socket = {
    rpc: async (method) => {
      if (method === "workspace.list") return [{ id: "workspace-owned", path: FIXTURE_PATH }];
      if (method === "thread.list") {
        return deletedThread ? [] : [{ id: "thread-owned", mode: "direct", workspace_id: "workspace-owned" }];
      }
      if (method === "thread.delete") {
        deletedThread = true;
        return true;
      }
      if (method === "workspace.delete") return false;
      throw new Error(`Unexpected RPC ${method}`);
    },
  };

  await expect(cleanupOwnedRun(socket, REPO_ROOT, EVIDENCE_DIRECTORY, ownedRecord({ ownsWorkspace: true }))).rejects
    .toThrow("workspace.delete did not remove");
});

test("verifies an owned workspace is absent after its delete succeeds", async () => {
  let deletedThread = false;
  let deletedWorkspace = false;
  const socket = {
    rpc: async (method) => {
      if (method === "workspace.list") {
        return deletedWorkspace ? [] : [{ id: "workspace-owned", path: FIXTURE_PATH }];
      }
      if (method === "thread.list") {
        return deletedThread ? [] : [{ id: "thread-owned", mode: "direct", workspace_id: "workspace-owned" }];
      }
      if (method === "thread.delete") {
        deletedThread = true;
        return true;
      }
      if (method === "workspace.delete") {
        deletedWorkspace = true;
        return true;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  };

  await expect(cleanupOwnedRun(socket, REPO_ROOT, EVIDENCE_DIRECTORY, ownedRecord({ ownsWorkspace: true }))).resolves
    .toEqual({ deletedThread: true, stoppedWorkspace: true });
});

test("rejects receipt paths that could escape the owned evidence directory", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  try {
    expect(() => evidenceFile(evidence, "../outside.json")).toThrow("file name is invalid");
  } finally {
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("rejects an evidence directory symlink before it can receive a receipt", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-link-${Date.now()}`);
  NodeFS.symlinkSync(NodePath.join(REPO_ROOT, ".dev"), evidence, "junction");
  try {
    expect(() => evidenceFile(evidence, "receipt.json")).toThrow("linked or unavailable");
  } finally {
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("lists retained no-provider navigation receipts without reading their contents", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  const name = `${RUN_ID}-navigation-repro-receipt.json`;
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(evidence, "receipts", name), "{}", "utf8");
  try {
    expect(listKnownReceipts(REPO_ROOT, evidence)).toEqual([
      `.dev/verification/${NodePath.basename(evidence)}/receipts/${name}`,
    ]);
  } finally {
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("keeps the model panel open while it asserts an already selected model", async () => {
  const operations = [];
  let expanded = false;
  const page = {
    getByTestId: (id) => {
      if (id === "model-selector-trigger") {
        return {
          click: async () => { expanded = !expanded; operations.push(`toggle:${expanded}`); },
          getAttribute: async (name) => name === "aria-expanded" ? String(expanded) : null,
        };
      }
      if (id === "model-group-codex") return {
        getAttribute: async () => "true",
        isDisabled: async () => false,
        waitFor: async () => operations.push(`provider-visible:${expanded}`),
      };
      if (id === "model-selector-panel-search") return {
        fill: async () => operations.push(`search:${expanded}`),
        waitFor: async () => operations.push(`search-visible:${expanded}`),
      };
      throw new Error(`Unexpected test id ${id}`);
    },
    getByRole: (_role, { name }) => {
      if (name === "Model, selected") return {
        getAttribute: async () => "true",
        isVisible: async () => expanded,
        waitFor: async () => operations.push(`selected-visible:${expanded}`),
      };
      throw new Error(`Unexpected role ${name}`);
    },
  };

  await selectProviderModelInUi(page, { model: "model-id", modelLabel: "Model", provider: "codex" });

  expect(operations).toEqual([
    "toggle:true",
    "provider-visible:true",
    "search-visible:true",
    "search:true",
    "provider-visible:true",
    "search:true",
    "selected-visible:true",
    "toggle:false",
  ]);
});

test("requires array RPC responses before it reports deleted resources absent", async () => {
  let deleted = false;
  const socket = {
    rpc: async (method) => {
      if (method === "workspace.list") return [{ id: "workspace-owned", path: FIXTURE_PATH }];
      if (method === "thread.list") return deleted ? {} : [{ id: "thread-owned", mode: "direct", workspace_id: "workspace-owned" }];
      if (method === "thread.delete") {
        deleted = true;
        return true;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  };

  await expect(cleanupOwnedRun(socket, REPO_ROOT, EVIDENCE_DIRECTORY, ownedRecord())).rejects
    .toThrow("thread.list returned an invalid response");
});

test("removes an owned fixture workspace even when no thread was created", async () => {
  let deletedWorkspace = false;
  const socket = {
    rpc: async (method) => {
      if (method === "workspace.list") return deletedWorkspace ? [] : [{ id: "workspace-owned", path: FIXTURE_PATH }];
      if (method === "workspace.delete") {
        deletedWorkspace = true;
        return true;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  };

  await expect(cleanupOwnedRun(
    socket,
    REPO_ROOT,
    EVIDENCE_DIRECTORY,
    ownedRecord({ ownsWorkspace: true, threadId: null }),
  )).resolves.toEqual({ deletedThread: false, stoppedWorkspace: true });
});

test("retains navigation recovery metadata when exact Electron cleanup fails", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({
    id: `${RUN_ID}-navigation`,
    model: "navigation",
    provider: "navigation",
    sessionFileName: "electron-composer-queue-navigation-deadbeef.json",
  });
  try {
    writeActiveRun(evidence, record);
    expect(finishNavigationRepro(evidence, record, null, "exact Electron session remains")).toBe("exact Electron session remains");
    expect(NodeFS.existsSync(NodePath.join(evidence, "active-run.json"))).toBe(true);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("rejects an existing linked evidence component before making a receipts directory", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-composer-queue-evidence-"));
  const dev = NodePath.join(root, ".dev");
  const target = NodePath.join(root, "outside");
  NodeFS.mkdirSync(dev);
  NodeFS.mkdirSync(target);
  NodeFS.symlinkSync(target, NodePath.join(dev, "verification"), "junction");
  try {
    expect(() => resolveEvidenceDirectory(root, true)).toThrow("linked or unavailable");
    expect(NodeFS.existsSync(NodePath.join(target, "composer-queue", "receipts"))).toBe(false);
  } finally {
    NodeFS.rmSync(root, { force: true, recursive: true });
  }
});

test("records generic terminal evidence without retaining provider payloads", () => {
  expect(summarizeQueueProviderEvents("thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", type: "turnStarted" } },
    { channel: "agent.event", data: { outcome: "completed", threadId: "thread-owned", type: "ended" } },
  ])).toEqual({ providerTerminalObserved: true, terminalEventCount: 1, turnStartedEventCount: 1 });
  expect(summarizeQueueProviderEvents("thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", type: "turnComplete" } },
    { channel: "agent.event", data: { outcome: "completed", threadId: "thread-owned", type: "ended" } },
    { channel: "agent.event", data: { threadId: "other", type: "turnComplete" } },
  ])).toEqual({ providerTerminalObserved: true, terminalEventCount: 1, turnStartedEventCount: 1 });
});

test("records Codex starts and Cursor terminal pairs as adapter diagnostics", () => {
  const codex = verifyQueueProviderEvidence("codex", "thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "b", type: "turnStarted" } },
  ], 3);
  expect(codex).toMatchObject({
    aStartedAfterRootTerminal: true,
    bStartedAfterContinue: true,
    rootStarted: true,
    rootTerminalObserved: true,
  });

  const cursor = verifyQueueProviderEvidence("cursor", "thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { outcome: "completed", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
  ], null);
  expect(cursor.rootStarted).toBe(false);
  expect(cursor.cursorRootTerminalSequenceCount).toBe(1);
  expect(cursor.cursorRootTerminalObserved).toBe(true);
});

test("rejects Cursor duplicate and unsuccessful terminal sequences", () => {
  const duplicateTurnComplete = verifyQueueProviderEvidence("cursor", "thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { outcome: "completed", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
  ], null);
  expect(duplicateTurnComplete.cursorRootTerminalObserved).toBe(false);

  const duplicateCompletedEnd = verifyQueueProviderEvidence("cursor", "thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { outcome: "completed", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
    { channel: "agent.event", data: { outcome: "completed", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
  ], null);
  expect(duplicateCompletedEnd.cursorRootTerminalObserved).toBe(false);

  const stopped = verifyQueueProviderEvidence("cursor", "thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { outcome: "stopped", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
  ], null);
  expect(stopped.cursorRootTerminalObserved).toBe(false);
});

test("uses short non-mutating terminal wait prompts for the queue journey", () => {
  const record = ownedRecord();

  expect(rootPrompt(record)).toContain('powershell -NoProfile -Command "Start-Sleep -Milliseconds 5000"');
  expect(queuePrompt("A", record)).toContain('powershell -NoProfile -Command "Start-Sleep -Milliseconds 10000"');
  expect(rootPrompt(record)).not.toContain("Read CONTEXT.md");
  expect(queuePrompt("A", record)).not.toContain("Read README.md");
});

test("accepts an already absent exact Electron session but not an unresolved one", () => {
  expect(isStoppedElectronSession({ status: "not-running" }, false)).toBe(true);
  expect(isStoppedElectronSession({ status: "stopped" }, false)).toBe(true);
  expect(isStoppedElectronSession({ status: "already-stopped" }, false)).toBe(true);
  expect(isStoppedElectronSession({ status: "not-running" }, true)).toBe(false);
  expect(isStoppedElectronSession({ status: "unknown" }, false)).toBe(false);
});

test("persists a provider recovery record before a workspace or thread identifier exists", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({ ownsWorkspace: false, threadId: null, workspaceId: null });
  try {
    writeActiveRun(evidence, record);
    expect(JSON.parse(NodeFS.readFileSync(NodePath.join(evidence, "active-run.json"), "utf8"))).toEqual(record);
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("does not accept a malformed workspace absence response after deletion", async () => {
  let deletedThread = false;
  let deletedWorkspace = false;
  const socket = {
    rpc: async (method) => {
      if (method === "workspace.list") {
        if (deletedWorkspace) return {};
        return [{ id: "workspace-owned", path: FIXTURE_PATH }];
      }
      if (method === "thread.list") {
        return deletedThread ? [] : [{ id: "thread-owned", mode: "direct", workspace_id: "workspace-owned" }];
      }
      if (method === "thread.delete") {
        deletedThread = true;
        return true;
      }
      if (method === "workspace.delete") {
        deletedWorkspace = true;
        return true;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  };

  await expect(cleanupOwnedRun(socket, REPO_ROOT, EVIDENCE_DIRECTORY, ownedRecord({ ownsWorkspace: true }))).rejects
    .toThrow("workspace.list returned an invalid response");
});

test("records root, A, and B start ordering from one event stream", () => {
  const events = [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "ended" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "b", type: "turnStarted" } },
  ];

  expect(verifyQueueTurnEvidence("thread-owned", events, 4)).toEqual({
    aStartEventCount: 1,
    aStartedAfterRootTerminal: true,
    bStartEventCount: 1,
    bStartedAfterContinue: true,
    providerTerminalObserved: true,
    rootStartEventCount: 1,
    rootStarted: true,
    rootTerminalObserved: true,
    terminalEventCount: 1,
    turnStartedEventCount: 3,
  });
  expect(verifyQueueTurnEvidence("thread-owned", events.slice(1), 3).rootStarted).toBe(false);

  expect(verifyQueueTurnEvidence("thread-owned", [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnStarted" } },
    { channel: "agent.event", data: { outcome: "completed", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
  ], null)).toMatchObject({ aStartedAfterRootTerminal: true, rootTerminalObserved: true });
});

test("uses one Electron-local socket for Composer queue RPCs and provider events", async () => {
  const uiSocket = { source: "electron-local" };
  const worktreeSocket = { source: "worktree-runtime" };
  expect(requireSameQueueSocket(uiSocket, uiSocket)).toBe(uiSocket);
  expect(() => requireSameQueueSocket(uiSocket, worktreeSocket)).toThrow("same Electron-local socket");
  const evidence = { events: [] };
  let opened = 0;
  const socket = await openQueueSocket(async (onPush) => {
    opened += 1;
    onPush({ channel: "agent.event", data: { threadId: "thread-owned", type: "turnStarted" } });
    return uiSocket;
  }, ownedRecord(), evidence);
  expect(socket).toBe(uiSocket);
  expect(opened).toBe(1);
  expect(summarizeQueueProviderEvents("thread-owned", evidence.events).turnStartedEventCount).toBe(1);
});

test("activates the local push subscription before root submission", async () => {
  const calls = [];
  const evidence = { subscribedBeforeRoot: false };
  await subscribeBeforeRootSubmission({
    rpc: async (method, params) => {
      calls.push([method, params]);
      return { canonicalRecoveries: [], hydrationRequiredThreadIds: [], replayedThrough: {} };
    },
  }, evidence);
  expect(calls).toEqual([["push.setThreadSubscriptions", { threadIds: [] }]]);
  expect(evidence.subscribedBeforeRoot).toBe(true);
});

test("persists unresolved workspace ownership before a lost create response", async () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const record = ownedRecord({ ownsWorkspace: false, threadId: null, workspaceId: null });
  const socket = {
    rpc: async (method) => {
      if (method === "workspace.list") return [];
      if (method === "workspace.create") throw new Error("workspace create response was lost");
      throw new Error(`Unexpected RPC ${method}`);
    },
  };
  try {
    writeActiveRun(evidence, record);
    await expect(ensureFixtureWorkspace(socket, REPO_ROOT, record, () => writeActiveRun(evidence, record))).rejects
      .toThrow("workspace create response was lost");
    expect(record.workspaceCreationPending).toBe(true);
    await expect(cleanupOwnedRun(socket, REPO_ROOT, evidence, record)).rejects
      .toThrow("workspace ownership is uncertain");
    expect(JSON.parse(NodeFS.readFileSync(NodePath.join(evidence, "active-run.json"), "utf8"))).toMatchObject({
      workspaceCreationPending: true,
      workspaceId: null,
    });
  } finally {
    removeActiveRun(evidence, record.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("keeps the winning active record when a competing finalizer settles", () => {
  const evidence = NodePath.join(REPO_ROOT, ".dev", "verification", `composer-queue-test-${Date.now()}`);
  NodeFS.mkdirSync(NodePath.join(evidence, "receipts"), { recursive: true });
  const winner = ownedRecord();
  const loser = ownedRecord({
    id: `${RUN_ID}-cursor`,
    provider: "cursor",
    sessionFileName: "electron-composer-queue-cursor-deadbeef.json",
  });
  try {
    writeActiveRun(evidence, winner);
    expect(() => writeActiveRun(evidence, loser)).toThrow("still active");
    expect(finishInterruptedCleanup(evidence, loser, null, null)).toContain("belongs to a different run");
    expect(JSON.parse(NodeFS.readFileSync(NodePath.join(evidence, "active-run.json"), "utf8"))).toEqual(winner);
  } finally {
    removeActiveRun(evidence, winner.id);
    NodeFS.rmSync(evidence, { force: true, recursive: true });
  }
});

test("reconnects interrupted cleanup through its recorded Electron-local runtime directory", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-composer-queue-runtime-"));
  const runtimeDirectory = NodePath.join(root, ".dev", "electron-composer-queue-codex-deadbeef", "runtime");
  NodeFS.mkdirSync(runtimeDirectory, { recursive: true });
  const record = ownedRecord({ electronRuntimeDirectory: runtimeDirectory });
  const opened = [];
  try {
    const socket = await openInterruptedQueueSocket(root, record, async (repoRoot, directory) => {
      opened.push([repoRoot, directory]);
      return { source: "electron-local" };
    });
    expect(socket).toEqual({ source: "electron-local" });
    expect(opened).toEqual([[root, runtimeDirectory]]);
  } finally {
    NodeFS.rmSync(root, { force: true, recursive: true });
  }
});

test("rejects unsafe or linked Electron runtime directories in recovery metadata", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-composer-queue-runtime-"));
  const expected = NodePath.join(root, ".dev", "electron-composer-queue-codex-deadbeef", "runtime");
  const outside = NodePath.join(root, "outside");
  NodeFS.mkdirSync(expected, { recursive: true });
  NodeFS.mkdirSync(outside);
  try {
    expect(() => validateOwnedElectronRuntimeDirectory(root, ownedRecord({
      electronRuntimeDirectory: outside,
    }))).toThrow("does not identify the owned Electron session");
    NodeFS.rmSync(expected, { force: true, recursive: true });
    NodeFS.symlinkSync(outside, expected, "junction");
    expect(() => validateOwnedElectronRuntimeDirectory(root, ownedRecord({
      electronRuntimeDirectory: expected,
    }))).toThrow("is linked or unavailable");
  } finally {
    NodeFS.rmSync(root, { force: true, recursive: true });
  }
});

test("rejects duplicate starts and stopped or cancelled ended events as successful queue completion", () => {
  const cancelled = [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnStarted" } },
    { channel: "agent.event", data: { outcome: "cancelled", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
  ];
  expect(verifyQueueTurnEvidence("thread-owned", cancelled, null).rootTerminalObserved).toBe(false);

  const stopped = [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnStarted" } },
    { channel: "agent.event", data: { outcome: "stopped", threadId: "thread-owned", turnExecutionId: "root", type: "ended" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
  ];
  expect(verifyQueueTurnEvidence("thread-owned", stopped, null).rootTerminalObserved).toBe(false);

  const duplicateA = [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
  ];
  expect(verifyQueueTurnEvidence("thread-owned", duplicateA, null).aStartedAfterRootTerminal).toBe(false);

  const duplicateB = [
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "root", type: "turnComplete" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "a", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "b", type: "turnStarted" } },
    { channel: "agent.event", data: { threadId: "thread-owned", turnExecutionId: "b", type: "turnStarted" } },
  ];
  expect(verifyQueueTurnEvidence("thread-owned", duplicateB, 3).bStartedAfterContinue).toBe(false);
});
