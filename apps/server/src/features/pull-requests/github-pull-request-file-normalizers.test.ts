import { describe, expect, it } from "vitest";
import {
  PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
  PULL_REQUEST_PATCH_MAX_LINES,
} from "@mcode/contracts";
import {
  createPullRequestFileLocator,
  decodePullRequestFileLocator,
  isGithubGeneratedPath,
  normalizeGithubPullRequestFile,
  normalizeGithubPullRequestPatch,
} from "./github-pull-request-file-normalizers.js";

const projectedFile = {
  sha: "c".repeat(40),
  filename: "src/renamed.ts",
  status: "renamed",
  additions: 4,
  deletions: 2,
  changes: 6,
  previous_filename: "src/original.ts",
  has_patch: true,
};

describe("GitHub pull request file normalization", () => {
  it("normalizes projected rename metadata and round-trips its opaque locator", () => {
    const file = normalizeGithubPullRequestFile(projectedFile, 17);
    expect(file).toEqual({
      globalPosition: 17,
      path: "src/renamed.ts",
      previousPath: "src/original.ts",
      changeType: "renamed",
      additions: 4,
      deletions: 2,
      changes: 6,
      blobOid: "c".repeat(40),
      hasPatch: true,
    });

    const locator = createPullRequestFileLocator(file!);
    expect(decodePullRequestFileLocator(locator)).toEqual({
      position: 17,
      fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("rejects mismatched rename metadata and hostile paths", () => {
    expect(normalizeGithubPullRequestFile({
      ...projectedFile,
      previous_filename: undefined,
    }, 0)).toBeNull();
    expect(normalizeGithubPullRequestFile({
      ...projectedFile,
      filename: "src/unsafe\nname.ts",
    }, 0)).toBeNull();
  });

  it("uses only matching linguist-generated attributes as generated evidence", () => {
    expect(isGithubGeneratedPath("src/api.generated.ts", [{
      directory: "",
      text: "*.generated.ts linguist-generated\npackage-lock.json -linguist-generated",
    }])).toBe(true);
    expect(isGithubGeneratedPath("package-lock.json", [])).toBe(false);
    expect(isGithubGeneratedPath("src/file.ts", [{
      directory: "src",
      text: "*.ts linguist-generated=true\nfile.ts -linguist-generated",
    }])).toBe(false);
  });

  it("bounds provider patches and reconstructs bounded text when GitHub omits one", () => {
    expect(normalizeGithubPullRequestPatch({
      patch: "@@ -1 +1 @@\n-old\n+new",
      oldText: null,
      newText: null,
      binary: false,
      generated: true,
      blobTooLarge: false,
    })).toMatchObject({ status: "generated", parsedLineCount: 3 });

    expect(normalizeGithubPullRequestPatch({
      patch: null,
      oldText: "old",
      newText: "new",
      binary: false,
      generated: false,
      blobTooLarge: false,
    })).toEqual({
      status: "available",
      patch: "@@ -1,1 +1,1 @@\n-old\n+new",
      parsedLineCount: 3,
    });
    expect(normalizeGithubPullRequestPatch({
      patch: null,
      oldText: null,
      newText: null,
      binary: true,
      generated: false,
      blobTooLarge: false,
    }).status).toBe("binary");
    expect(normalizeGithubPullRequestPatch({
      patch: null,
      oldText: null,
      newText: null,
      binary: false,
      generated: false,
      blobTooLarge: true,
    }).status).toBe("too_large");
    expect(normalizeGithubPullRequestPatch({
      patch: "x".repeat(PULL_REQUEST_PATCH_MAX_LINE_LENGTH + 1),
      oldText: null,
      newText: null,
      binary: false,
      generated: false,
      blobTooLarge: false,
    }).status).toBe("too_large");
    const exactUtf8Line = "é".repeat(PULL_REQUEST_PATCH_MAX_LINE_LENGTH / 2);
    expect(normalizeGithubPullRequestPatch({
      patch: exactUtf8Line,
      oldText: null,
      newText: null,
      binary: false,
      generated: false,
      blobTooLarge: false,
    }).status).toBe("available");
    expect(normalizeGithubPullRequestPatch({
      patch: `${exactUtf8Line}é`,
      oldText: null,
      newText: null,
      binary: false,
      generated: false,
      blobTooLarge: false,
    }).status).toBe("too_large");

    const reconstructedBoundary = `x${"é".repeat((PULL_REQUEST_PATCH_MAX_LINE_LENGTH - 2) / 2)}`;
    expect(normalizeGithubPullRequestPatch({
      patch: null,
      oldText: "",
      newText: reconstructedBoundary,
      binary: false,
      generated: false,
      blobTooLarge: false,
    }).status).toBe("available");
    expect(normalizeGithubPullRequestPatch({
      patch: null,
      oldText: "",
      newText: `${reconstructedBoundary}x`,
      binary: false,
      generated: false,
      blobTooLarge: false,
    }).status).toBe("too_large");
    expect(normalizeGithubPullRequestPatch({
      patch: Array.from({ length: PULL_REQUEST_PATCH_MAX_LINES + 1 }, () => " x").join("\n"),
      oldText: null,
      newText: null,
      binary: false,
      generated: false,
      blobTooLarge: false,
    }).status).toBe("too_large");
  });
});
