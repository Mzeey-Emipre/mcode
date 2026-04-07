/**
 * GitHub PR operations service.
 * Wraps the `gh` CLI for pull request lookups and listing.
 * Extracted from apps/desktop/src/main/github.ts.
 */

import { injectable, inject } from "tsyringe";
import { execFile } from "child_process";
import type { PrInfo, PrDetail } from "@mcode/contracts";
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

  /** Input for creating a new GitHub pull request. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // (interface kept inline to avoid extra exports)

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
      "--json",
      "number,url",
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
          let parsed: unknown;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            reject(new Error("Invalid JSON response from gh CLI"));
            return;
          }
          const data = parsed as Record<string, unknown>;
          if (typeof data.number !== "number" || typeof data.url !== "string") {
            reject(new Error("Invalid gh response: missing or malformed number/url"));
            return;
          }
          resolve({ number: data.number, url: data.url });
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
