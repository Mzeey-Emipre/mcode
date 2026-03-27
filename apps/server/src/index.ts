/**
 * Mcode server entry point.
 * Starts the HTTP + WebSocket server and registers graceful shutdown handlers.
 */

import { setupContainer } from "./container.js";
import { createWsServer } from "./transport/ws-server.js";
import { broadcast } from "./transport/push.js";
import { logger } from "@mcode/shared";

// Services
import { WorkspaceService } from "./services/workspace-service.js";
import { ThreadService } from "./services/thread-service.js";
import { AgentService } from "./services/agent-service.js";
import { GitService } from "./services/git-service.js";
import { GithubService } from "./services/github-service.js";
import { FileService } from "./services/file-service.js";
import { ConfigService } from "./services/config-service.js";
import { SkillService } from "./services/skill-service.js";
import { TerminalService } from "./services/terminal-service.js";
import { MessageRepo } from "./repositories/message-repo.js";
import { ThreadRepo } from "./repositories/thread-repo.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import { WebSocket } from "ws";
import type { AgentEvent } from "@mcode/contracts";
import type Database from "better-sqlite3";

const PORT = parseInt(process.env.MCODE_PORT ?? "19400", 10);

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

// Wire up push broadcasting for agent events and thread status changes
for (const provider of providerRegistry.resolveAll()) {
  provider.on("event", (event: AgentEvent) => {
    broadcast("agent.event", event);

    if (event.type === "turnComplete") {
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
});

httpServer.listen(PORT, HOST, () => {
  logger.info(`Mcode server listening on ${HOST}:${PORT}`);
});

/**
 * Gracefully shut down all services, close WebSocket connections,
 * and stop the HTTP server before exiting the process.
 */
function shutdown(): void {
  logger.info("Shutting down...");

  // 1. Stop all agent sessions
  agentService.stopAll();

  // 2. Shutdown provider registry
  providerRegistry.shutdown();

  // 3. Mark active threads as interrupted
  threadService.markActiveThreadsInterrupted(agentService.activeThreadIds());

  // 4. Shutdown terminal service
  terminalService.shutdown();

  // 5. Close all WebSocket clients and shut down the WS server
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, "Server shutting down");
    }
  }
  wss.close();

  // 6. Close the HTTP server to stop accepting new connections
  httpServer.close();

  // 7. Close database
  try {
    db.close();
  } catch {
    // Already closed or other non-fatal error
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
