import type { McodeTransport, Workspace, Thread, Message, GitBranch, WorktreeInfo, AttachmentMeta, PrInfo } from "./types";

export function createElectronTransport(): McodeTransport {
  const api = window.electronAPI;

  if (!api) {
    throw new Error(
      "Electron preload API not available. Ensure the preload script exposes window.electronAPI.",
    );
  }

  return {
    async createWorkspace(name, path) {
      return api.invoke("create-workspace", name, path) as Promise<Workspace>;
    },

    async listWorkspaces() {
      return api.invoke("list-workspaces") as Promise<Workspace[]>;
    },

    async deleteWorkspace(id) {
      return api.invoke("delete-workspace", id) as Promise<boolean>;
    },

    async createThread(workspaceId, title, mode, branch) {
      return api.invoke(
        "create-thread",
        workspaceId,
        title,
        mode,
        branch,
      ) as Promise<Thread>;
    },

    async listThreads(workspaceId) {
      return api.invoke("list-threads", workspaceId) as Promise<Thread[]>;
    },

    async deleteThread(threadId, cleanupWorktree) {
      return api.invoke(
        "delete-thread",
        threadId,
        cleanupWorktree,
      ) as Promise<boolean>;
    },

    async listBranches(workspaceId) {
      return api.invoke("list-branches", workspaceId) as Promise<GitBranch[]>;
    },

    async getCurrentBranch(workspaceId) {
      return api.invoke("get-current-branch", workspaceId) as Promise<string>;
    },

    async checkoutBranch(workspaceId, branch) {
      await api.invoke("checkout-branch", workspaceId, branch);
    },

    async listWorktrees(workspaceId) {
      return api.invoke("list-worktrees", workspaceId) as Promise<WorktreeInfo[]>;
    },

    async sendMessage(threadId, content, model, permissionMode, attachments) {
      await api.invoke("send-message", threadId, content, model, permissionMode, attachments);
    },

    async createAndSendMessage(workspaceId, content, model, permissionMode, mode, branch, existingWorktreePath, attachments) {
      return api.invoke(
        "create-and-send-message",
        workspaceId, content, model, permissionMode, mode, branch, existingWorktreePath, attachments,
      ) as Promise<Thread>;
    },

    async updateThreadTitle(threadId, title) {
      return api.invoke("update-thread-title", threadId, title) as Promise<boolean>;
    },

    async markThreadViewed(threadId) {
      await api.invoke("mark-thread-viewed", threadId);
    },

    async stopAgent(threadId) {
      await api.invoke("stop-agent", threadId);
    },

    async readClipboardImage() {
      return api.invoke("read-clipboard-image") as Promise<AttachmentMeta | null>;
    },

    async getActiveAgentCount() {
      return api.invoke("get-active-agent-count") as Promise<number>;
    },

    async getMessages(threadId, limit) {
      return api.invoke(
        "get-messages",
        threadId,
        limit,
      ) as Promise<Message[]>;
    },

    async discoverConfig(workspacePath) {
      return api.invoke(
        "discover-config",
        workspacePath,
      ) as Promise<Record<string, unknown>>;
    },

    async getVersion() {
      return api.invoke("get-version") as Promise<string>;
    },

    async detectEditors() {
      return api.invoke("detect-editors") as Promise<string[]>;
    },

    async openInEditor(editor, dirPath) {
      await api.invoke("open-in-editor", editor, dirPath);
    },

    async openInExplorer(dirPath) {
      await api.invoke("open-in-explorer", dirPath);
    },

    async getBranchPr(branch, cwd) {
      return api.invoke("get-branch-pr", branch, cwd) as Promise<PrInfo | null>;
    },
  };
}
