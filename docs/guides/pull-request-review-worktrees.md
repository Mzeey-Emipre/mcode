# Pull Request Review Worktrees

This guide defines the server invariants for turning a pull request into a local
Review task. Setup may change Git and SQLite, but performs no remote write.

## Entry points

`pullRequest.createReviewTask` has three actions:

- `prepare` resolves the canonical task, Workspace, compatible worktree, and
  proposed managed destination.
- `create_new` confirms a server-owned worktree leaf and the head OID observed
  during preparation.
- `reuse_existing` confirms an opaque candidate ID. The server rediscovers the
  candidate under the same Workspace and head snapshot. It never accepts a
  filesystem path from the renderer.

`pullRequest.reviewLink` restores the PR URL and state, worktree, local branch,
head OID, and push target for an active canonical thread.

## Completed-thread retention ownership

Automatic cleanup may remove a worktree filesystem only when its resolved path
is a descendant of the canonical Mcode `worktrees` directory and no active
thread shares it. A missing managed checkout is pruned from Git and its saved
named branch is removed. An external, unmanaged, shared, or non-descendant
worktree keeps its filesystem and Git state; only the thread's database row and
generated artifacts expire. Cleanup also keeps a named checkout when the
repository default branch cannot be identified.

## Repository mapping

The base repository maps to a Workspace through normalized Git remotes. SSH,
SCP-style, HTTP, and HTTPS forms compare as one host and repository path. The
selected Workspace must still match when the user confirms.

Zero matches return `workspace_mapping_missing`. Multiple matches return
`workspace_mapping_ambiguous` with at most 50 bounded candidates. The retry must
name one of those Workspace IDs.

## Immutable head fetch

The service refreshes PR detail immediately before mutation. The PR must be open
and expose a head repository, branch, and OID. Git uses argument arrays and
validated refs.

The fetch sequence is:

1. Reuse a URL-equivalent remote only when its effective push URL also targets
   the PR head repository.
2. For a fork without a safe remote, add
   `mcode-pr-<head-repository-node-hash>`. Never rewrite an existing remote.
3. Fetch `refs/heads/<head>` into the matching remote-tracking ref.
4. Resolve `FETCH_HEAD^{commit}` and compare it with the captured head OID.
5. Create an attempt-owned immutable ref under
   `refs/mcode/pull-requests/<repository>/<number>/<oid>`.

A changed or missing head stops before branch creation. Remote-tracking rollback
uses compare-and-swap OIDs, so it cannot overwrite a concurrent fetch.

## Branch, upstream, and worktree

Same-repository PRs prefer a valid, absent head branch up to 100 characters.
Forks and collisions use
`mcode/pr-<number>-<owner>-<head>-<oid7>`, followed by suffixes `-2` through
`-99`. Existing branches remain untouched unless their OID and upstream already
match the PR head and they are not attached elsewhere.

A compatible worktree gets an opaque candidate ID. Reuse requires a live,
real-path-resolved registration. A junction or symlink outside managed storage
is treated as unmanaged.

New destinations are managed leaf names checked for lexical and real-path
containment. The Workspace checkout is never switched or reset.

## Persistence and idempotency

`pull_request_review_links` has one row per provider, repository node ID, and PR
number. It stores remote state, checkout ownership, head identity, local branch,
explicit push target, managed-remote ownership, and the canonical thread.

The service locks per identity and rereads the link. The database unique
constraint is the final arbiter. Thread and link writes share one immediate
SQLite transaction. A loser rolls back its Git artifacts and returns the winner.

The first turn stores the user's visible intent while sending a separate,
48 KiB bounded provider payload. PR description, checks, and unresolved review
threads are marked as untrusted remote data. The payload identifies its first
page, record limits, continuation state, and truncation markers. Provider startup
failure does not delete the local task or worktree.

## Push target

The local branch name may differ from the contributor's head branch. Review
links therefore persist `push_remote` and `push_ref`. A linked push fetches that
remote ref, requires the remote head to be an ancestor of local `HEAD`, and then
uses `git push <remote> HEAD:refs/heads/<ref>` without force.

Before fetch or push, the server verifies the remote and every push URL against
the head repository. Drift returns a conflict instead of using `origin`.

## Rollback and deletion

An attempt records ownership before `git worktree add`, including checkout hook
failures. Rollback uses exact paths and OID-guarded refs. It never prunes the
repository or deletes pre-existing state.

An attempt-owned managed remote is removed only while the repository lock is
held and no branch configuration references it. Temporary immutable refs are
removed after the branch and worktree protect the head.

Deleting a canonical thread clears `primary_thread_id` immediately. Filesystem
cleanup runs only for app-managed worktrees with no active sibling using the
same path. Reused unmanaged worktrees and shared worktrees remain on disk.

## Verification floor

Cover same-repository and fork remotes, push URL drift, equivalent remotes, head
drift, branch collisions, stale or escaping paths, partial creation, concurrency,
migration constraints, and deletion ownership. Then run `bun run verify`.
