# Derive Worktree Folder Name from Branch Name - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive worktree folder names from the git branch name instead of the thread title, so folders are recognizable on disk.

**Architecture:** Replace the inline title-based sanitization in `ThreadService.create()` with a call to an improved `sanitizeBranchForFolder()` function in `packages/shared/src/git/`. The existing `toWorktreeSlug()` function is unused and will be replaced with the new function that handles slashes, consecutive hyphens, leading/trailing hyphens, and leading dots.

**Tech Stack:** TypeScript, Vitest, tsyringe DI

**Closes:** #100

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/shared/src/git/index.ts` | Replace `toWorktreeSlug` with `sanitizeBranchForFolder` |
| Modify | `packages/shared/src/index.ts` | Update re-export |
| Create | `packages/shared/vitest.config.ts` | Vitest config for shared package |
| Modify | `packages/shared/package.json` | Add `test` script |
| Create | `packages/shared/src/git/__tests__/sanitize-branch-for-folder.test.ts` | Unit tests |
| Modify | `apps/server/src/services/thread-service.ts:57-63` | Use branch-based naming |

---

### Task 1: Add Vitest to `packages/shared`

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/vitest.config.ts`

- [ ] **Step 1: Add vitest config**

Create `packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Add test script to package.json**

In `packages/shared/package.json`, add `"test": "vitest run"` to the `scripts` object:

```json
"scripts": {
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

- [ ] **Step 3: Verify vitest runs (no tests yet)**

Run: `cd packages/shared && bun run test`
Expected: exits cleanly with "no test files found" or similar (no error).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/vitest.config.ts packages/shared/package.json
git commit -m "chore: add vitest config to shared package"
```

---

### Task 2: Write failing tests for `sanitizeBranchForFolder`

**Files:**
- Create: `packages/shared/src/git/__tests__/sanitize-branch-for-folder.test.ts`

- [ ] **Step 1: Write the test file**

Create `packages/shared/src/git/__tests__/sanitize-branch-for-folder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sanitizeBranchForFolder } from "../index";

describe("sanitizeBranchForFolder", () => {
  it("replaces slashes with hyphens", () => {
    expect(sanitizeBranchForFolder("fix/oauth-login")).toBe("fix-oauth-login");
  });

  it("replaces whitespace with hyphens", () => {
    expect(sanitizeBranchForFolder("feat/add user profiles")).toBe(
      "feat-add-user-profiles",
    );
  });

  it("lowercases the result", () => {
    expect(sanitizeBranchForFolder("Fix/OAuth-Login")).toBe("fix-oauth-login");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeBranchForFolder("foo--bar")).toBe("foo-bar");
  });

  it("strips leading hyphens", () => {
    expect(sanitizeBranchForFolder("-leading")).toBe("leading");
  });

  it("strips trailing hyphens", () => {
    expect(sanitizeBranchForFolder("trailing-")).toBe("trailing");
  });

  it("strips leading dots", () => {
    expect(sanitizeBranchForFolder(".dotfile")).toBe("dotfile");
  });

  it("replaces special characters with hyphens", () => {
    expect(sanitizeBranchForFolder("feat/add@user#profiles!")).toBe(
      "feat-add-user-profiles",
    );
  });

  it("handles a simple branch name with no special chars", () => {
    expect(sanitizeBranchForFolder("hotfix")).toBe("hotfix");
  });

  it("handles multiple slashes", () => {
    expect(sanitizeBranchForFolder("user/feat/thing")).toBe("user-feat-thing");
  });

  it("handles mixed special chars, whitespace, and slashes", () => {
    expect(sanitizeBranchForFolder("feat/my cool--feature!")).toBe(
      "feat-my-cool-feature",
    );
  });

  it("throws for input that is all special chars (empty result)", () => {
    expect(() => sanitizeBranchForFolder("///...")).toThrow(
      "produces an empty folder name",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && bun run test`
Expected: FAIL - `sanitizeBranchForFolder` is not exported / does not exist.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/git/__tests__/sanitize-branch-for-folder.test.ts
git commit -m "test: add failing tests for sanitizeBranchForFolder"
```

---

### Task 3: Implement `sanitizeBranchForFolder` and remove `toWorktreeSlug`

**Files:**
- Modify: `packages/shared/src/git/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Replace `toWorktreeSlug` with `sanitizeBranchForFolder` in `packages/shared/src/git/index.ts`**

Replace the existing `toWorktreeSlug` function (lines 63-69) with:

```ts
/**
 * Sanitize a git branch name into a filesystem-safe folder name.
 * Replaces slashes, whitespace, and non-alphanumeric characters with hyphens,
 * collapses consecutive hyphens, and strips leading dots/hyphens and trailing hyphens.
 * Throws if the result is empty (i.e. the input contained no alphanumeric characters).
 * Callers should validate the branch name with {@link validateBranchName} before calling this.
 */
export function sanitizeBranchForFolder(branch: string): string {
  const result = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "");
  if (!result) {
    throw new Error(
      `Branch name "${branch}" produces an empty folder name after sanitization`,
    );
  }
  return result;
}
```

- [ ] **Step 2: Update the re-export in `packages/shared/src/index.ts`**

Replace `toWorktreeSlug` with `sanitizeBranchForFolder` in the git utilities export block:

```ts
// Git utilities
export {
  validateWorktreeName,
  validateBranchName,
  sanitizeBranchForFolder,
} from "./git/index.js";
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd packages/shared && bun run test`
Expected: All 12 tests PASS.

- [ ] **Step 4: Run typecheck to verify no broken imports**

Run: `cd packages/shared && bun run typecheck`
Expected: No errors. (`toWorktreeSlug` was unused outside the shared package.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/git/index.ts packages/shared/src/index.ts
git commit -m "feat: add sanitizeBranchForFolder, remove unused toWorktreeSlug"
```

---

### Task 4: Update `ThreadService` to derive folder name from branch

**Files:**
- Modify: `apps/server/src/services/thread-service.ts:57-63`

- [ ] **Step 1: Add import for `sanitizeBranchForFolder`**

In `apps/server/src/services/thread-service.ts`, update the import from `@mcode/shared` (line 8):

```ts
import { validateBranchName, sanitizeBranchForFolder } from "@mcode/shared";
```

- [ ] **Step 2: Replace title-based sanitization with branch-based**

Replace lines 57-63:

```ts
      const sanitizedTitle = title
        .split("")
        .map((c) => (/[a-zA-Z0-9-]/.test(c) ? c : "-"))
        .join("")
        .toLowerCase();
      const shortId = thread.id.slice(0, 8);
      const worktreeName = `${sanitizedTitle}-${shortId}`;
```

With:

```ts
      const shortId = thread.id.slice(0, 8);
      const worktreeName = `${sanitizeBranchForFolder(branch)}-${shortId}`;
```

- [ ] **Step 3: Run full test suite**

Run: `bun run test` (from repo root)
Expected: All tests pass. No existing tests reference the old title-based naming.

- [ ] **Step 4: Run typecheck across the repo**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/thread-service.ts
git commit -m "fix: derive worktree folder name from branch name, not thread title

Closes #100"
```

---

## Verification

After all tasks, manually verify the examples from the issue:

| Branch | Expected Folder Pattern |
|--------|------------------------|
| `fix/oauth-login` | `fix-oauth-login-<8char>` |
| `feat/add user profiles` | `feat-add-user-profiles-<8char>` |
| `hotfix` | `hotfix-<8char>` |
