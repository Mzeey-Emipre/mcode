import { createServer, type Server, type Socket } from "net";
import type { MessagePortLike } from "./port-push.js";
import { logger } from "@mcode/shared";

/**
 * IPC push server using named pipes (Windows) or Unix domain sockets (macOS/Linux).
 * Each connected client gets a MessagePortLike adapter for use with PortPush.
 */
export class IpcPushServer {
  private server: Server | null = null;
  private connectionHandler: ((port: MessagePortLike) => void) | null = null;
  private sockets = new Set<Socket>();

  /** Whether the server is actively listening. */
  get isListening(): boolean {
    return this.server?.listening ?? false;
  }

  /** Register a handler called when a client connects. */
  onConnection(handler: (port: MessagePortLike) => void): void {
    this.connectionHandler = handler;
  }

  /** Start listening on the given IPC path. */
  async listen(ipcPath: string): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", (err) => {
        logger.error("IPC socket error", { err });
        this.sockets.delete(socket);
      });

      const adapter = createSocketAdapter(socket);
      this.connectionHandler?.(adapter);
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(ipcPath, () => {
        logger.info("IPC push server listening", { path: ipcPath });
        resolve();
      });
    });
  }

  /** Close the server and all connected sockets. */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    return new Promise<void>((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}

/**
 * Wrap a net.Socket in a MessagePortLike adapter.
 * Uses length-prefixed binary framing: [4-byte BE uint32 length][JSON payload].
 */
function createSocketAdapter(socket: Socket): MessagePortLike {
  return {
    postMessage(message: unknown): void {
      const json = JSON.stringify(message);
      const payload = Buffer.from(json, "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      try {
        socket.write(Buffer.concat([header, payload]));
      } catch {
        socket.destroy();
      }
    },

    close(): void {
      socket.end();
      socket.destroy();
    },

    on(event: string, listener: (...args: unknown[]) => void): void {
      if (event === "close" || event === "error") {
        socket.on(event, listener);
      }
    },
  };
}

/**
 * Generate a platform-appropriate IPC path for the server process.
 * Windows uses a named pipe; macOS/Linux use a Unix domain socket in mcodeDir.
 */
export function generateIpcPath(pid: number, mcodeDir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\mcode-${pid}`;
  }
  return `${mcodeDir}/mcode-${pid}.sock`;
}
