import type {
  McodeTransport,
  Workspace,
  Thread,
  Message,
  SkillInfo,
} from "@/transport/types";
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
    issue_number: null,
    pr_number: null,
    pr_status: null,
    session_name: "mcode-test",
    pid: null,
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
  discoverConfig: vi.fn().mockResolvedValue({}),
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
  readClipboardImage: vi.fn().mockResolvedValue(null),
  detectEditors: vi.fn().mockResolvedValue([]),
  openInEditor: vi.fn().mockResolvedValue(undefined),
  openInExplorer: vi.fn().mockResolvedValue(undefined),
  getBranchPr: vi.fn().mockResolvedValue(null),
  listSkills: vi.fn().mockResolvedValue([] as SkillInfo[]),
};
