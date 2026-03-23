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
