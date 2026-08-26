import type { Client } from "@agentclientprotocol/sdk";
import type { AcpSessionCallbacks } from "./acp-session-types.js";

/** Builds package-private capability-gated ACP client handlers from provider callbacks. */
export function createAcpClientHandlers(callbacks: AcpSessionCallbacks): Client {
  return {
    requestPermission: callbacks.onPermissionRequest,
    sessionUpdate: callbacks.onSessionUpdate,
    readTextFile: async ({ path }) => {
      if (!callbacks.readTextFile) throw new Error("ACP file read is unavailable");
      return { content: await callbacks.readTextFile(path) };
    },
    writeTextFile: async ({ path, content }) => {
      if (!callbacks.writeTextFile) throw new Error("ACP file write is unavailable");
      await callbacks.writeTextFile(path, content);
      return {};
    },
    extMethod: async (method, params) => {
      const result = callbacks.onExtensionRequest
        ? await callbacks.onExtensionRequest(method, params)
        : {};
      return result !== null && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : {};
    },
    extNotification: async (method, params) => {
      if (callbacks.onExtensionNotification) await callbacks.onExtensionNotification(method, params);
    },
  };
}
