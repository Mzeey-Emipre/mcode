import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GithubService } from "../services/github-service";

describe("GithubService.getCheckRuns", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    ghService = new GithubService({} as WorkspaceRepo);
  });

  it("returns passing status when all checks succeed", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "lint", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:08Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("passing");
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].name).toBe("build");
    expect(result.runs[0].conclusion).toBe("success");
    expect(result.runs[0].durationMs).toBe(23000);
  });

  it("returns failing status when any check fails", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", state: "FAILURE", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:45Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[1].conclusion).toBe("failure");
  });

  it("returns pending status when any check is in progress", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", state: "PENDING", startedAt: "2026-04-14T10:00:00Z", completedAt: null },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("pending");
    expect(result.runs[1].status).toBe("in_progress");
    expect(result.runs[1].durationMs).toBeNull();
  });

  it("returns no_checks when array is empty", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "[]");
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });

  it("returns no_checks on gh CLI error", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("gh not found"));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });
});
