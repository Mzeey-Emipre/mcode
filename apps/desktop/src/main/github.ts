/**
 * GitHub PR lookup via the `gh` CLI.
 * Returns PR metadata for a given branch, or null if no PR exists.
 */

import { execFile } from "child_process";

export interface PrInfo {
  readonly number: number;
  readonly url: string;
  readonly state: string;
}

/**
 * Look up the PR associated with a branch.
 * Runs `gh pr view <branch> --json number,url,state`.
 * Returns null if no PR exists, gh is not installed, or the command fails.
 */
export function getBranchPr(branch: string, cwd: string): Promise<PrInfo | null> {
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
          const data = JSON.parse(stdout) as { number?: number; url?: string; state?: string };
          if (typeof data.number === "number" && typeof data.url === "string") {
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

/** Detailed PR metadata for branch picker and URL detection. */
export interface PrDetail {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly author: string;
  readonly url: string;
  readonly state: string;
}

/**
 * List open PRs for the repository.
 * Runs `gh pr list --json ...` and returns up to 30 results.
 * Returns [] if `gh` CLI is not installed or the command fails.
 */
export function listOpenPrs(cwd: string): Promise<PrDetail[]> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      [
        "pr", "list",
        "--json", "number,title,headRefName,author,url,state",
        "--limit", "30",
      ],
      { cwd, encoding: "utf-8", timeout: 15_000 },
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
            if (typeof item.number === "number" && typeof item.headRefName === "string") {
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
 * Look up a PR by its GitHub URL.
 * Parses `github.com/:owner/:repo/pull/:number` and runs `gh pr view`.
 * Returns null if the URL is invalid, `gh` is not installed, or the command fails.
 */
export function getPrByUrl(url: string): Promise<PrDetail | null> {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return Promise.resolve(null);

  const repo = match[1];
  const prNumber = match[2];

  return new Promise((resolve) => {
    execFile(
      "gh",
      [
        "pr", "view", prNumber,
        "--repo", repo,
        "--json", "number,title,headRefName,author,url,state",
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
          if (typeof data.number === "number" && typeof data.headRefName === "string") {
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
