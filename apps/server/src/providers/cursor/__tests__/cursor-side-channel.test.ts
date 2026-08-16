import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../store/database.js";
import { ThreadRepo } from "../../../repositories/thread-repo.js";
import { MessageRepo } from "../../../repositories/message-repo.js";
import { CursorProvider } from "../cursor-provider.js";
import { BrowserAutomationSessionLease } from "../../../features/browser-automation/index.js";
import type { InternalThreadControlMcpRuntime } from "../../../features/thread-control/index.js";
import type { SettingsService } from "../../../services/settings-service.js";
import type { SkillService } from "../../../services/skill-service.js";
import type { EnvService } from "../../../services/env-service.js";
import type { JobObject } from "../../../services/job-object.js";
import type { Client } from "@agentclientprotocol/sdk";
import type { ForkRequest } from "@mcode/contracts";

/**
 * Slice 1 proof: forking a Cursor thread runs the handoff through the clean
 * side-channel (path B) and leaves the parent's canonical session untouched -
 * zero new `is_internal` rows and an unchanged max sequence - while still
 * producing a non-empty handoff for the child.
 */
describe("Cursor clean side-channel fork", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageRepo;
  let provider: CursorProvider;

  const SUMMARY = "Parent was fixing the auth middleware; tests added next.";

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    messageRepo = new MessageRepo(db);

    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run(
      "ws-1",
      "test",
      "/tmp/test",
    );

    const settingsStub = {
      get: () => ({ provider: { cursor: { idleSessionTtlMinutes: 30 }, cli: {} } }),
    } as unknown as SettingsService;
    const skillStub = {} as unknown as SkillService;
    const envStub = { getEnv: () => ({}) } as unknown as EnvService;
    const jobStub = {} as unknown as JobObject;
    const threadControlStub = {} as InternalThreadControlMcpRuntime;
    const browserAutomationLease = new BrowserAutomationSessionLease();

    provider = new CursorProvider(
      settingsStub,
      skillStub,
      envStub,
      jobStub,
      threadControlStub,
      browserAutomationLease,
    );

    expect((provider as unknown as { threadControlMcp: InternalThreadControlMcpRuntime }).threadControlMcp)
      .toBe(threadControlStub);
    expect((provider as unknown as { browserAutomationLease: BrowserAutomationSessionLease }).browserAutomationLease)
      .toBe(browserAutomationLease);

    // Replace the real `cursor-agent acp` spawn with a fake transport that
    // streams a summary chunk back through the client (no subprocess, no
    // events). `prompt` mimics the agent answering on the loaded session id.
    (provider as unknown as { sideChannelConnector: unknown }).sideChannelConnector = (args: {
      cwd: string;
      client: Client;
    }) => {
      let loadedSessionId = "";
      return Promise.resolve({
        loadSession: (a: { sessionId: string }) => {
          loadedSessionId = a.sessionId;
          return Promise.resolve({});
        },
        prompt: async () => {
          await args.client.sessionUpdate({
            sessionId: loadedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: SUMMARY },
            },
          });
          return {};
        },
        dispose: () => {},
      });
    };
  });

  it("produces a path-B handoff without mutating the parent session", async () => {
    const parent = threadRepo.create("ws-1", "Fix auth bug", "direct", "main", true, "cursor");
    messageRepo.create(parent.id, "user", "Fix the auth bug", 1);
    messageRepo.create(parent.id, "assistant", "Fixed the middleware.", 2);
    threadRepo.updateSdkSessionId(parent.id, "cursor-parent-session");
    const seededParent = threadRepo.findById(parent.id)!;

    const child = threadRepo.create("ws-1", "Branch: add tests", "direct", "main", true, "cursor", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-2",
    });

    const beforeRows = messageRepo.listIncludingInternal(parent.id);
    const beforeInternalCount = beforeRows.filter((m) => m.is_internal).length;
    const beforeMaxSequence = Math.max(...beforeRows.map((m) => m.sequence));

    const req: ForkRequest = {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-2",
      forkAnchorRole: "assistant",
      prompt: "Summarize the parent thread for handoff.",
      cwd: "/tmp/test",
      parentSdkSessionId: seededParent.sdk_session_id,
      conversationHistory: "user: Fix the auth bug\nassistant: Fixed the middleware.",
      messagesUpToFork: [],
      parentThread: seededParent,
      childThreadId: child.id,
    };

    const artifact = await provider.forker.fork(req);

    expect(artifact.markdown).toContain(SUMMARY);
    expect(artifact.markdown.length).toBeGreaterThan(0);
    expect(artifact.meta.ladderStep).toBe("B");
    expect(artifact.meta.generatedBy).toBe("provider");

    const afterRows = messageRepo.listIncludingInternal(parent.id);
    const afterInternalCount = afterRows.filter((m) => m.is_internal).length;
    const afterMaxSequence = Math.max(...afterRows.map((m) => m.sequence));

    expect(afterInternalCount).toBe(beforeInternalCount);
    expect(afterInternalCount).toBe(0);
    expect(afterRows).toHaveLength(beforeRows.length);
    expect(afterMaxSequence).toBe(beforeMaxSequence);
  });

  it("degrades to a transient error (path-D trigger) when the parent has no session", async () => {
    const parent = threadRepo.create("ws-1", "No session", "direct", "main", true, "cursor");
    messageRepo.create(parent.id, "user", "Do a thing", 1);
    const seededParent = threadRepo.findById(parent.id)!;
    const child = threadRepo.create("ws-1", "child", "direct", "main", true, "cursor", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-1",
    });

    const req: ForkRequest = {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-1",
      forkAnchorRole: "user",
      prompt: "Summarize.",
      cwd: "/tmp/test",
      parentSdkSessionId: null,
      messagesUpToFork: [],
      parentThread: seededParent,
      childThreadId: child.id,
    };

    await expect(provider.forker.fork(req)).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
});
