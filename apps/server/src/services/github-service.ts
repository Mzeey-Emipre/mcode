/**
 * GitHub PR operations service.
 * Wraps the `gh` CLI for pull request lookups and listing.
 * Extracted from apps/desktop/src/main/github.ts.
 */

import { injectable, inject } from "tsyringe";
import { execFile } from "child_process";
import type { PrInfo, PrDetail, ChecksStatus, CheckRun } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";

/** Handles GitHub PR lookups and listing via the gh CLI. */
@injectable()
export class GithubService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  /** Look up the PR associated with a branch in the given working directory. */
  getBranchPr(branch: string, cwd: string): Promise<PrInfo | null> {
    return new Promise((resolve) => {
      execFile(
        "gh",
        ["pr", "view", branch, "--json", "number,url,state"],
        { cwd, encoding: "utf-8", timeout: 10_000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(stdout) as {
              number?: number;
              url?: string;
              state?: string;
            };
            if (
              typeof data.number === "number" &&
              typeof data.url === "string"
            ) {
              resolve({
                number: data.number,
                url: data.url,
                state: data.state ?? "OPEN",
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  /** List open PRs for a workspace's repository. */
  async listOpenPrs(workspaceId: string): Promise<PrDetail[]> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    return new Promise((resolve) => {
      execFile(
        "gh",
        [
          "pr",
          "list",
          "--json",
          "number,title,headRefName,author,url,state",
          "--limit",
          "30",
        ],
        { cwd: workspace.path, encoding: "utf-8", timeout: 15_000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve([]);
            return;
          }
          try {
            const items = JSON.parse(stdout) as Array<{
              number?: number;
              title?: string;
              headRefName?: string;
              author?: { login?: string };
              url?: string;
              state?: string;
            }>;
            const results: PrDetail[] = [];
            for (const item of items) {
              if (
                typeof item.number === "number" &&
                typeof item.headRefName === "string"
              ) {
                results.push({
                  number: item.number,
                  title: item.title ?? "",
                  branch: item.headRefName,
                  author: item.author?.login ?? "",
                  url: item.url ?? "",
                  state: item.state ?? "OPEN",
                });
              }
            }
            resolve(results);
          } catch {
            resolve([]);
          }
        },
      );
    });
  }

  /**
   * Create a GitHub pull request via the gh CLI.
   * Returns the new PR's number and URL.
   */
  createPr(input: {
    cwd: string;
    title: string;
    body: string;
    baseBranch: string;
    isDraft: boolean;
  }): Promise<{ number: number; url: string }> {
    const args = [
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      input.body,
      "--base",
      input.baseBranch,
    ];
    if (input.isDraft) {
      args.push("--draft");
    }

    return new Promise((resolve, reject) => {
      execFile(
        "gh",
        args,
        { cwd: input.cwd, encoding: "utf-8", timeout: 30_000 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          // gh pr create outputs the PR URL to stdout, possibly preceded by
          // warning/info lines. Extract the URL from anywhere in the output.
          const prUrlMatch = stdout.match(/https:\/\/[^\s]*\/pull\/(\d+)/);
          if (!prUrlMatch) {
            reject(new Error(`Unexpected gh pr create output: ${stdout.trim()}`));
            return;
          }
          const number = parseInt(prUrlMatch[1], 10);
          const url = prUrlMatch[0];
          resolve({ number, url });
        },
      );
    });
  }

  /**
   * Fetch CI check runs for a PR. Uses `gh pr checks` for simplicity.
   * Returns aggregate status and individual check details.
   */
  getCheckRuns(prNumber: number, repoPath: string): Promise<ChecksStatus> {
    return new Promise((resolve) => {
      execFile(
        "gh",
        ["pr", "checks", String(prNumber), "--json", "name,state,startedAt,completedAt"],
        { cwd: repoPath, encoding: "utf-8", timeout: 15_000 },
        (error, stdout) => {
          const now = Date.now();
          if (error || !stdout) {
            resolve({ aggregate: "no_checks", runs: [], fetchedAt: now });
            return;
          }
          try {
            const items = JSON.parse(stdout) as Array<{
              name?: string;
              state?: string;
              startedAt?: string | null;
              completedAt?: string | null;
            }>;

            if (items.length === 0) {
              resolve({ aggregate: "no_checks", runs: [], fetchedAt: now });
              return;
            }

            const runs = items.map((item) => {
              const ghState = (item.state ?? "").toUpperCase();
              const completed = ghState === "SUCCESS" || ghState === "FAILURE"
                || ghState === "CANCELLED" || ghState === "SKIPPED"
                || ghState === "TIMED_OUT" || ghState === "NEUTRAL"
                || ghState === "ACTION_REQUIRED" || ghState === "STALE";

              const status = completed ? "completed" as const
                : ghState === "QUEUED" ? "queued" as const
                : "in_progress" as const;

              // ACTION_REQUIRED blocks merge like a failure; STALE is abandoned (terminal like cancelled).
              const conclusionMap: Record<string, CheckRun["conclusion"]> = {
                SUCCESS: "success",
                FAILURE: "failure",
                CANCELLED: "cancelled",
                SKIPPED: "skipped",
                TIMED_OUT: "timed_out",
                NEUTRAL: "neutral",
                ACTION_REQUIRED: "failure",
                STALE: "cancelled",
              };
              const conclusion = completed ? (conclusionMap[ghState] ?? "cancelled") : null;

              let durationMs: number | null = null;
              if (completed && item.startedAt && item.completedAt) {
                durationMs = new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime();
              }

              return {
                name: item.name ?? "unknown",
                status,
                conclusion,
                durationMs,
              };
            });

            let aggregate: "passing" | "failing" | "pending" | "no_checks";
            if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out")) {
              aggregate = "failing";
            } else if (runs.some((r) => r.status !== "completed")) {
              aggregate = "pending";
            } else {
              aggregate = "passing";
            }

            // If all runs completed but none succeeded (all skipped/cancelled/neutral),
            // treat as no_checks to avoid a misleading green badge.
            if (aggregate === "passing" && !runs.some((r) => r.conclusion === "success")) {
              aggregate = "no_checks";
            }

            resolve({ aggregate, runs, fetchedAt: now });
          } catch {
            resolve({ aggregate: "no_checks", runs: [], fetchedAt: now });
          }
        },
      );
    });
  }

  /** Look up a PR by its GitHub URL. */
  getPrByUrl(url: string): Promise<PrDetail | null> {
    const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) return Promise.resolve(null);

    const repo = match[1];
    const prNumber = match[2];

    return new Promise((resolve) => {
      execFile(
        "gh",
        [
          "pr",
          "view",
          prNumber,
          "--repo",
          repo,
          "--json",
          "number,title,headRefName,author,url,state",
        ],
        { encoding: "utf-8", timeout: 15_000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(stdout) as {
              number?: number;
              title?: string;
              headRefName?: string;
              author?: { login?: string };
              url?: string;
              state?: string;
            };
            if (
              typeof data.number === "number" &&
              typeof data.headRefName === "string"
            ) {
              resolve({
                number: data.number,
                title: data.title ?? "",
                branch: data.headRefName,
                author: data.author?.login ?? "",
                url: data.url ?? "",
                state: data.state ?? "OPEN",
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
      );
    });
  }
}
