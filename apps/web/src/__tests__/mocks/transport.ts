import type {
  McodeTransport,
  Workspace,
  Thread,
  Message,
  SkillInfo,
} from "@/transport/types";
import { DEFAULT_SETTINGS } from "@mcode/contracts";
import { vi } from "vitest";

export function createMockWorkspace(
  overrides?: Partial<Workspace>,
): Workspace {
  return {
    id: crypto.randomUUID(),
    name: "test-project",
    path: "/tmp/test-project",
    provider_config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockThread(overrides?: Partial<Thread>): Thread {
  return {
    id: crypto.randomUUID(),
    workspace_id: crypto.randomUUID(),
    title: "Test Thread",
    status: "active",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    worktree_managed: false,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    deleted_at: null,
    ...overrides,
  };
}

export function createMockMessage(overrides?: Partial<Message>): Message {
  return {
    id: crypto.randomUUID(),
    thread_id: crypto.randomUUID(),
    role: "user",
    content: "Hello",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: new Date().toISOString(),
    sequence: 1,
    attachments: null,
    ...overrides,
  };
}

export const mockTransport: McodeTransport = {
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  deleteWorkspace: vi.fn().mockResolvedValue(true),
  createThread: vi.fn(),
  listThreads: vi.fn().mockResolvedValue([]),
  deleteThread: vi.fn().mockResolvedValue(true),
  listBranches: vi.fn().mockResolvedValue([]),
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
  checkoutBranch: vi.fn().mockResolvedValue(undefined),
  listWorktrees: vi.fn().mockResolvedValue([]),
  sendMessage: vi.fn().mockResolvedValue(1),
  stopAgent: vi.fn().mockResolvedValue(undefined),
  getActiveAgentCount: vi.fn().mockResolvedValue(0),
  getMessages: vi.fn().mockResolvedValue([]),
  createAndSendMessage: vi.fn(),
  updateThreadTitle: vi.fn().mockResolvedValue(true),
  markThreadViewed: vi.fn().mockResolvedValue(undefined),
  syncThreadPrs: vi.fn().mockResolvedValue([]),
  discoverConfig: vi.fn().mockResolvedValue({}),
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
  readClipboardImage: vi.fn().mockResolvedValue(null),
  saveClipboardFile: vi.fn().mockResolvedValue(null),
  listWorkspaceFiles: vi.fn().mockResolvedValue([]),
  readFileContent: vi.fn().mockResolvedValue(""),
  detectEditors: vi.fn().mockResolvedValue([]),
  openInEditor: vi.fn().mockResolvedValue(undefined),
  openInExplorer: vi.fn().mockResolvedValue(undefined),
  getBranchPr: vi.fn().mockResolvedValue(null),
  listOpenPrs: vi.fn().mockResolvedValue([]),
  fetchBranch: vi.fn().mockResolvedValue(undefined),
  getPrByUrl: vi.fn().mockResolvedValue(null),
  listSkills: vi.fn().mockResolvedValue([] as SkillInfo[]),
  terminalCreate: vi.fn().mockResolvedValue("pty-mock-1"),
  terminalWrite: vi.fn().mockResolvedValue(undefined),
  terminalResize: vi.fn().mockResolvedValue(undefined),
  terminalKill: vi.fn().mockResolvedValue(undefined),
  terminalKillByThread: vi.fn().mockResolvedValue(undefined),
  listToolCallRecords: vi.fn().mockResolvedValue([]),
  listToolCallRecordsByParent: vi.fn().mockResolvedValue([]),
  getSnapshotDiff: vi.fn().mockResolvedValue(""),
  cleanupSnapshots: vi.fn().mockResolvedValue({ removed: 0 }),
  getSettings: vi.fn().mockImplementation(() => Promise.resolve(structuredClone(DEFAULT_SETTINGS))),
  updateSettings: vi.fn().mockImplementation(() => Promise.resolve(structuredClone(DEFAULT_SETTINGS))),
  setBackground: vi.fn().mockResolvedValue(undefined),
};
