import type { McodeTransport } from "./types";
import { createElectronTransport } from "./electron";
import { createTauriTransport } from "./tauri";

export type { McodeTransport, Workspace, Thread, Message, ToolCall, GitBranch, WorktreeInfo, PermissionMode, InteractionMode, AttachmentMeta, StoredAttachment, SkillInfo, PrInfo, PrDetail } from "./types";
export { PERMISSION_MODES, INTERACTION_MODES } from "./types";

let transport: McodeTransport | null = null;

function isElectron(): boolean {
  return typeof window !== "undefined" && "electronAPI" in window;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createMockTransport(): McodeTransport {
  return {
    async getVersion() { return "0.2.0 (dev)"; },
    async listWorkspaces() { return []; },
    async createWorkspace() { throw new Error("Mock transport: createWorkspace not available"); },
    async deleteWorkspace() { return false; },
    async listThreads() { return []; },
    async createThread() { throw new Error("Mock transport: createThread not available"); },
    async deleteThread() { return false; },
    async listBranches() { return []; },
    async getCurrentBranch() { return "main"; },
    async checkoutBranch() {},
    async listWorktrees() { return []; },
    async sendMessage() {},
    async stopAgent() {},
    async getActiveAgentCount() { return 0; },
    async getMessages() { return []; },
    async discoverConfig() { return {}; },
    async createAndSendMessage() { throw new Error("Mock transport: createAndSendMessage not available"); },
    async updateThreadTitle() { return false; },
    async readClipboardImage() { return null; },
    async markThreadViewed() {},
    async listWorkspaceFiles() { return []; },
    async readFileContent() { return ""; },
    async detectEditors() { return []; },
    async openInEditor() {},
    async openInExplorer() {},
    async getBranchPr() { return null; },
    async listOpenPrs() { return []; },
    async fetchBranch() {},
    async getPrByUrl() { return null; },
    async listSkills(_cwd?: string) { return []; },
  };
}

export function getTransport(): McodeTransport {
  if (!transport) {
    if (isElectron()) {
      transport = createElectronTransport();
    } else if (isTauri()) {
      transport = createTauriTransport();
    } else {
      console.warn("No Electron or Tauri runtime detected, using mock transport");
      transport = createMockTransport();
    }
  }
  return transport;
}
