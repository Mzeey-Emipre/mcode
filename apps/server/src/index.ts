/**
 * Mcode server entry point.
 * Starts the HTTP + WebSocket server and registers graceful shutdown handlers.
 */

import { setupContainer } from "./container";
import { createWsServer } from "./transport/ws-server";
import { broadcast } from "./transport/push";
import { logger } from "@mcode/shared";

// Services
import { WorkspaceService } from "./services/workspace-service";
import { ThreadService } from "./services/thread-service";
import { AgentService } from "./services/agent-service";
import { GitService } from "./services/git-service";
import { GithubService } from "./services/github-service";
import { FileService } from "./services/file-service";
import { ConfigService } from "./services/config-service";
import { SkillService } from "./services/skill-service";
import { TerminalService } from "./services/terminal-service";
import { MessageRepo } from "./repositories/message-repo";
import { ThreadRepo } from "./repositories/thread-repo";
import { ToolCallRecordRepo } from "./repositories/tool-call-record-repo";
import { TurnSnapshotRepo } from "./repositories/turn-snapshot-repo";
import { SnapshotService } from "./services/snapshot-service";
import { SettingsService } from "./services/settings-service";
import { GitWatcherService } from "./services/git-watcher-service";
import { MemoryPressureService } from "./services/memory-pressure-service";
import { WorkspaceRepo } from "./repositories/workspace-repo";
import { ProviderRegistry } from "./providers/provider-registry";
import { WebSocket } from "ws";
import type { AgentEvent } from "@mcode/contracts";
import type Database from "better-sqlite3";

const PREFERRED_PORT = parseInt(process.env.MCODE_PORT ?? "19400", 10);
const MAX_PORT_ATTEMPTS = 10;

/**
 * Host address to bind the server to.
 * Defaults to 127.0.0.1 (loopback only) for security. Set MCODE_HOST to
 * "0.0.0.0" or "::" to expose the server on all network interfaces.
 */
const HOST = process.env.MCODE_HOST ?? "127.0.0.1";

// Initialize DI container
const container = setupContainer();

// Resolve services
const workspaceService = container.resolve(WorkspaceService);
const threadService = container.resolve(ThreadService);
const agentService = container.resolve(AgentService);
const gitService = container.resolve(GitService);
const githubService = container.resolve(GithubService);
const fileService = container.resolve(FileService);
const configService = container.resolve(ConfigService);
const skillService = container.resolve(SkillService);
const terminalService = container.resolve(TerminalService);
const messageRepo = container.resolve(MessageRepo);
const threadRepo = container.resolve(ThreadRepo);
const providerRegistry = container.resolve(ProviderRegistry);
const toolCallRecordRepo = container.resolve(ToolCallRecordRepo);
const turnSnapshotRepo = container.resolve(TurnSnapshotRepo);
const snapshotService = container.resolve(SnapshotService);
const settingsService = container.resolve(SettingsService);
const gitWatcherService = container.resolve(GitWatcherService);
const memoryPressureService = container.resolve(MemoryPressureService);
const workspaceRepo = container.resolve(WorkspaceRepo); // Used only for startup watcher initialization
const db = container.resolve<Database.Database>("Database");

// Wire up PTY sender to broadcast push events
terminalService.setSender((channel, data) => {
  if (channel === "terminal.data") {
    broadcast("terminal.data", data);
  } else if (channel === "terminal.exit") {
    broadcast("terminal.exit", data);
  }
});

// AgentService self-wires persistence and session tracking against providers
agentService.init();

// Run snapshot garbage collection on startup
const maxAge = parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10);
const removed = turnSnapshotRepo.deleteExpired(maxAge);
if (removed > 0) {
  logger.info(`Cleaned up ${removed} expired turn snapshots`);
}

// Initialize HEAD file watchers for all existing workspaces so branch changes
// are detected after a server restart.
for (const ws of workspaceRepo.listAll()) {
  gitWatcherService.watchWorkspace(ws.id, ws.path);
}

// Wire up push broadcasting for agent events and thread status changes.
// AgentService.init() registers its listener first, so bufferToolCall (which
// maintains the canonical agentCallStack) has already run by the time this
// listener fires. We read the stack via getCurrentParentToolCallId to enrich
// non-Agent tool calls with their parent ID.
for (const provider of providerRegistry.resolveAll()) {
  provider.on("event", (event: AgentEvent) => {
    let enrichedEvent = event;

    // Enrich non-Agent tool calls with parent ID from the canonical stack in AgentService
    if (event.type === "toolUse" && event.toolName !== "Agent") {
      const parentId = agentService.getCurrentParentToolCallId(event.threadId);
      if (parentId) {
        enrichedEvent = { ...event, parentToolCallId: parentId };
      }
    }

    broadcast("agent.event", enrichedEvent);

    if (event.type === "turnComplete") {
      threadRepo.updateStatus(event.threadId, "completed");
      broadcast("thread.status", {
        threadId: event.threadId,
        status: "completed",
      });
      const thread = threadRepo.findById(event.threadId);
      if (thread) {
        broadcast("files.changed", {
          workspaceId: thread.workspace_id,
          threadId: thread.id,
        });
      }
    } else if (event.type === "error") {
      threadRepo.updateStatus(event.threadId, "errored");
      broadcast("thread.status", {
        threadId: event.threadId,
        status: "errored",
      });
    }
  });
}

// Create and start HTTP + WS server
const { httpServer, wss } = createWsServer({
  workspaceService,
  threadService,
  agentService,
  gitService,
  githubService,
  fileService,
  configService,
  skillService,
  terminalService,
  messageRepo,
  toolCallRecordRepo,
  turnSnapshotRepo,
  snapshotService,
  settingsService,
  gitWatcherService,
  memoryPressureService,
});

/**
 * Attempt to bind to the preferred port, incrementing on EADDRINUSE.
 * Logs the actual port so the client can discover it.
 */
function listen(port: number, attempt = 1): void {
  httpServer.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
      logger.warn(`Port ${port} in use, trying ${port + 1}`);
      listen(port + 1, attempt + 1);
    } else {
      logger.error(`Failed to bind to port ${port}`, { error: String(err) });
      process.exit(1);
    }
  });
  httpServer.listen(port, HOST, () => {
    logger.info(`Mcode server listening on ${HOST}:${port}`);
  });
}

listen(PREFERRED_PORT);

/**
 * Gracefully shut down all services, close WebSocket connections,
 * and stop the HTTP server before exiting the process.
 * Awaits server close handshakes so in-flight connections drain cleanly.
 */
async function shutdown(): Promise<void> {
  logger.info("Shutting down...");

  // 1. Capture active thread IDs before stopAll() clears them
  const activeThreadIds = agentService.activeThreadIds();

  // 2. Stop all agent sessions
  agentService.stopAll();

  // 3. Shutdown provider registry
  providerRegistry.shutdown();

  // 4. Mark active threads as interrupted
  threadService.markActiveThreadsInterrupted(activeThreadIds);

  // 5. Dispose settings file watcher
  settingsService.dispose();

  // 6. Shutdown terminal service
  terminalService.shutdown();

  // 7. Dispose all git HEAD file watchers
  gitWatcherService.dispose();

  // 8. Dispose memory pressure timers
  memoryPressureService.dispose();

  // 10. Close all WebSocket clients and shut down the WS server
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, "Server shutting down");
    }
  }

  // 11. Await WS and HTTP server close so pending handshakes can finish
  const wssClose = new Promise<void>((res, rej) => {
    wss.close((err) => (err ? rej(err) : res()));
  });
  const httpClose = new Promise<void>((res, rej) => {
    httpServer.close((err) => (err ? rej(err) : res()));
  });

  await Promise.allSettled([wssClose, httpClose]);

  // 12. Close database
  try {
    db.close();
  } catch {
    // Already closed or other non-fatal error
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => {
  shutdown().catch((err) => {
    logger.error("Shutdown error", { error: String(err) });
    process.exit(1);
  });
});
process.once("SIGINT", () => {
  shutdown().catch((err) => {
    logger.error("Shutdown error", { error: String(err) });
    process.exit(1);
  });
});
