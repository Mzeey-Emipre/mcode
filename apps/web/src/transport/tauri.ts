import type { McodeTransport, Workspace, Thread, Message } from "./types";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

async function invokeJson<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const result = await invoke<string>(cmd, args);
  return JSON.parse(result) as T;
}

export function createTauriTransport(): McodeTransport {
  return {
    async createWorkspace(name, path) {
      return invokeJson<Workspace>("create_workspace", { name, path });
    },

    async listWorkspaces() {
      return invokeJson<Workspace[]>("list_workspaces");
    },

    async deleteWorkspace(id) {
      return invoke<boolean>("delete_workspace", { id });
    },

    async createThread(workspaceId, title, mode, branch) {
      return invokeJson<Thread>("create_thread", {
        workspaceId,
        title,
        mode,
        branch,
      });
    },

    async listThreads(workspaceId) {
      return invokeJson<Thread[]>("list_threads", { workspaceId });
    },

    async deleteThread(threadId, cleanupWorktree) {
      return invoke<boolean>("delete_thread", { threadId, cleanupWorktree });
    },

    async listBranches() {
      throw new Error("Not implemented in Tauri");
    },

    async getCurrentBranch() {
      throw new Error("Not implemented in Tauri");
    },

    async checkoutBranch() {
      throw new Error("Not implemented in Tauri");
    },

    async sendMessage(threadId, content, model, permissionMode) {
      await invoke<void>("send_message", { threadId, content, model, permissionMode });
    },

    async createAndSendMessage() {
      throw new Error("Not implemented in Tauri");
    },

    async updateThreadTitle() {
      throw new Error("Not implemented in Tauri");
    },

    async markThreadViewed() {
      throw new Error("Not implemented in Tauri");
    },

    async stopAgent(threadId) {
      return invoke<void>("stop_agent", { threadId });
    },

    async getActiveAgentCount() {
      return invoke<number>("get_active_agent_count");
    },

    async getMessages(threadId, limit) {
      return invokeJson<Message[]>("get_messages", { threadId, limit });
    },

    async discoverConfig(workspacePath) {
      return invokeJson<Record<string, unknown>>("discover_config", { workspacePath });
    },

    async getVersion() {
      return invoke<string>("get_version");
    },

    async readClipboardImage() {
      return null;
    },
  };
}

export { isTauri };
