---
name: coderabbit-loop
description: >
  Iteratively improves a GitHub PR or GitLab MR until CodeRabbit leaves zero unresolved
  actionable comments. Triggers a CodeRabbit review, fixes all actionable comments,
  pushes, re-triggers review, and repeats. Use when the user wants to fully resolve a
  PR/MR against CodeRabbit's review feedback before requesting human review.
license: MIT
compatibility: Requires git, gh (GitHub CLI) or glab (GitLab CLI) authenticated, and CodeRabbit installed on the repo (app or GitLab integration).
metadata:
  author: cjnwo
  version: "1.0"
allowed-tools: Bash(gh:*) Bash(glab:*) Bash(git:*) Bash(jq:*)
---

# CodeRabbit Loop

Iteratively fix a PR/MR until CodeRabbit has zero unresolved actionable comments.

## Inputs

- **PR/MR number** (optional): If not provided, detect from the current branch.
- **`--include-nits`** (optional): Also fix nitpick comments. Default: skip nits, only fix actionable comments.
- **`--max-iterations N`** (optional): Cap the loop. Default: 5.
- **`--vcs github|gitlab`** (optional): Override auto-detection for self-hosted GitLab instances whose hostname doesn't contain "gitlab".

## Exit Conditions

Stop the loop if **any** of these are true:

- Zero unresolved actionable CodeRabbit comments on the latest commit.
- Max iterations reached (report remaining issues).
- CodeRabbit posts `LGTM!` / `Approved` as the latest review state.

Note: CodeRabbit has no numeric score. The success signal is "no unresolved actionable threads on HEAD." Nitpicks are skipped by default because they tend to be style-level and can chew iterations without material gain.

## Instructions

### 0. Detect platform

```bash
REMOTE_URL=$(git remote get-url origin)
if echo "$REMOTE_URL" | grep -qi "gitlab"; then
  VCS="gitlab"
else
  VCS="github"
fi
```

User can override with `--vcs gitlab` for self-hosted instances.

### 1. Identify the PR/MR

**GitHub:**
```bash
gh pr view --json number,headRefName,headRefOid \
  -q '{number: .number, branch: .headRefName, sha: .headRefOid}'
```

**GitLab:**
```bash
glab mr view --output json | jq '{iid: .iid, branch: .source_branch, sha: .sha}'
```

If not on the PR/MR branch, switch to it first.

Key field differences:
- GitHub: `number`, `headRefName`, `headRefOid`
- GitLab: `iid`, `source_branch`, `sha`

### 2. Loop

Repeat the cycle. **Default max 5 iterations** to prevent runaway loops and rate-limit burn.

#### A. Trigger CodeRabbit review

Push the latest local changes first (if any):

```bash
git push
sleep 5
```

Post the review trigger as a PR/MR comment. CodeRabbit listens for the `@coderabbitai` mention:

- Use `@coderabbitai review` for an incremental review of new changes since the last review.
- Use `@coderabbitai full review` for a clean-slate review that ignores prior comments. Prefer this on iteration 1 if the PR already has stale CodeRabbit comments you've already addressed in-branch.

**GitHub:**
```bash
# Only trigger if CodeRabbit isn't already reviewing
CR_IN_FLIGHT=$(gh pr view <PR_NUMBER> --json comments \
  --jq '[.comments[] | select(.author.login == "coderabbitai" and (.body | test("review in progress|reviewing"; "i")))] | length')

if [ "$CR_IN_FLIGHT" = "0" ]; then
  gh pr comment <PR_NUMBER> --body "@coderabbitai review"
fi
```

**GitLab:**
```bash
glab mr note <MR_IID> --message "@coderabbitai review"
```

#### B. Wait for CodeRabbit to finish

CodeRabbit typically posts a "walkthrough" / summary comment and a set of inline review threads when done. Poll until a new review appears that references the current HEAD SHA.

**GitHub:**
```bash
HEAD_SHA=$(gh pr view <PR_NUMBER> --json headRefOid -q .headRefOid)

for i in $(seq 1 60); do
  LATEST_REVIEW=$(gh api "repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews" \
    --jq "[.[] | select(.user.login == \"coderabbitai[bot]\")] | sort_by(.submitted_at) | last")

  LATEST_SHA=$(echo "$LATEST_REVIEW" | jq -r '.commit_id // empty')

  if [ "$LATEST_SHA" = "$HEAD_SHA" ]; then
    echo "CodeRabbit review complete for $HEAD_SHA"
    break
  fi

  echo "Waiting for CodeRabbit review on $HEAD_SHA... ($i/60)"
  sleep 10
done
```

**GitLab:** CodeRabbit posts notes from a bot user (commonly `coderabbitai` — confirm the exact username from an existing comment on first run). Poll the discussions endpoint until a new bot-authored note's `created_at` exceeds the time the trigger was posted, and the note body references the current SHA or review summary header.

```bash
glab api "projects/:fullpath/merge_requests/<MR_IID>/notes?per_page=100" \
  | jq '[.[] | select(.author.username | test("coderabbitai"; "i"))] | sort_by(.created_at) | last'
```

Timeout: bail out of the poll after ~10 minutes and report that CodeRabbit never responded (usually means the app isn't installed on the repo, or it's paused via `@coderabbitai ignore` in the PR description).

#### C. Fetch CodeRabbit findings

CodeRabbit puts findings in two places — check **both**:

**1. The review summary** (walkthrough + "Actionable comments posted: N" counter):

**GitHub:**
```bash
gh api "repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews" \
  --jq '[.[] | select(.user.login == "coderabbitai[bot]")] | sort_by(.submitted_at) | last | .body'
```

The body typically contains a line like:
```
**Actionable comments posted: 3**
```
Parse that count for quick triage. A count of `0` on the latest review is the happy path.

**2. Unresolved inline review threads on HEAD:**

**GitHub (GraphQL):**
```bash
gh api graphql -f query='
query {
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: <PR_NUMBER>) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 10) {
            nodes {
              body
              path
              line
              author { login }
            }
          }
        }
      }
    }
  }
}' | jq '[.data.repository.pullRequest.reviewThreads.nodes[]
  | select(.isResolved == false and .isOutdated == false)
  | select(.comments.nodes[0].author.login == "coderabbitai")]'
```

**GitLab:**
```bash
glab api "projects/:fullpath/merge_requests/<MR_IID>/discussions?per_page=100" \
  | jq '[.[] | select(.notes[0].type == "DiffNote"
                      and .notes[0].resolved == false
                      and (.notes[0].author.username | test("coderabbitai"; "i")))]'
```

#### D. Classify and filter

For each unresolved CodeRabbit comment body, classify it:

| Signal in body                                         | Category   | Default action |
| ------------------------------------------------------ | ---------- | -------------- |
| `⚠️ Potential issue`, `🛠️ Refactor suggestion`, `🐛 Bug` | Actionable | Fix it         |
| `🧹 Nitpick`, `Nitpick (assertive)`                     | Nitpick    | Skip (unless `--include-nits`) |
| `💡 Verification agent`, `ℹ️ Note`                      | Info       | Skip, resolve if already addressed |
| `📝 Committable suggestion`                             | Actionable | Apply the suggestion if it's correct |

CodeRabbit emoji/header conventions are stable but do change occasionally. If the comment starts with italic warning/nit markers or is wrapped in `<details>` (nitpicks are often collapsed), treat the same way.

#### E. Fix actionable comments

For each actionable, unresolved comment:

1. Read the referenced file at the given `path:line`.
2. Understand the comment in full code context, not just the snippet CodeRabbit quoted.
3. If the fix is correct, apply it.
4. If CodeRabbit is wrong (false positive, misunderstood intent), note the reasoning. Do not apply. Still resolve the thread in step F with a reply explaining why.
5. If the fix is partial or requires a design decision beyond the loop's scope, stop the loop and surface it to the user. Don't force-resolve threads that raise real design questions.

#### F. Resolve addressed threads

**GitHub** — resolve each thread whose issue you addressed (or chose not to address with reason):

```bash
# IDs come from the GraphQL query in step C
gh api graphql -f query='
mutation {
  t1: resolveReviewThread(input: {threadId: "THREAD_ID_1"}) { thread { isResolved } }
  t2: resolveReviewThread(input: {threadId: "THREAD_ID_2"}) { thread { isResolved } }
}'
```

For threads where you disagreed with CodeRabbit, first post a reply explaining why, then resolve:

```bash
gh api graphql -f query='
mutation {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: "THREAD_ID",
    body: "Skipping: <reason>. Context: <1-2 line explanation>."
  }) { comment { id } }
}'
```

Alternatively, `@coderabbitai resolve` as a top-level PR comment marks **all** prior CodeRabbit comments as resolved. Use with care, only on iteration 1 to clear out stale pre-loop feedback.

**GitLab:**
```bash
glab api --method PUT \
  "projects/:fullpath/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>" \
  --field resolved=true
```

GitLab has no batch mutation. Loop per discussion ID.

#### G. Commit and push

```bash
git add -A
git commit -m "fix: address CodeRabbit review feedback (iteration N)"
git push
sleep 5
```

Go back to step **A**.

### 3. Rate-limit awareness

CodeRabbit has internal rate limits, and aggressive re-triggering can cause the bot to skip reviews or rate-limit the account. Between iterations:

- Wait at least 10 seconds after `git push` before posting `@coderabbitai review`.
- If the review poll in step B returns the *same* SHA as the previous iteration after 5 minutes, CodeRabbit likely skipped it. Post `@coderabbitai full review` once to force a fresh pass, then continue.
- Never post more than one `@coderabbitai review` comment per iteration.

### 4. Report

After exiting the loop, summarize:

| Field              | Value                                       |
| ------------------ | ------------------------------------------- |
| Platform           | GitHub / GitLab                             |
| Iterations         | N                                           |
| Actionable fixed   | N                                           |
| Nitpicks skipped   | N (or "fixed" if `--include-nits`)          |
| Remaining          | N (list if any)                             |
| Skipped with reason| N (list with reasons)                       |

## Output format

```
CodeRabbit loop complete.
  Platform:          GitHub
  PR:                #482
  Iterations:        3
  Actionable fixed:  7
  Nitpicks skipped:  4
  Remaining:         0
```

If stopped short:

```
CodeRabbit loop stopped after 5 iterations.
  Platform:          GitHub
  PR:                #482
  Actionable fixed:  9
  Remaining:         2

Remaining issues:
  - src/auth.ts:45 — "Rate limit this endpoint to prevent credential stuffing"
  - src/db.ts:112 — "Missing index on user_id, query will full-scan at scale"

Skipped with reason:
  - src/util.ts:88 — False positive: code path is unreachable from external input.
```

## Notes

- This skill assumes CodeRabbit is already installed on the repository. If step B times out with no bot response, check the GitHub/GitLab app installation and that the PR description doesn't contain `@coderabbitai ignore`.
- `.coderabbit.yaml` in the repo root controls review scope, tone (`chill` vs `assertive`), and path filters. The loop doesn't modify it. If too much noise comes back, tune the config instead of bloating the loop with filters.
- The CLI (`cr --prompt-only --type uncommitted`) is a separate tool for pre-PR local review. This skill is PR/MR-based only.
