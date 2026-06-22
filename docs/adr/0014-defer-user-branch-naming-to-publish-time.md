---
status: proposed
---

# User-facing branch naming is deferred to publish time

## Context

Mcode currently exposes branch naming before a new worktree thread starts. The
composer can ask for an automatic, custom, or AI-generated branch name even
though the user often does not yet know what the agent will produce.

The Codex Environment panel takes a quieter route. It shows where work is
running, such as Local or Worktree, and offers Create branch as a later action
from the environment menu. That pattern matches Mcode's product principle that
the next step should appear when the user reaches it.

Git worktrees still require a branch ref when they are created. That ref is
scaffolding. It should not make the user choose a public branch name before the
work exists.

## Decision

Mcode will stop exposing user-facing branch naming before a run. New worktree
threads get an app-generated local branch automatically. The generated branch
name is an internal checkout detail, not a product decision and not a setting.

The user-facing branch decision moves to the Overview, following Codex's
Environment pattern. The Overview shows the working location and branch state,
then offers Create branch as a late action when the user is ready to publish or
open a pull request.

Create branch is no longer a persistent inline branch-name field in the
top-level Overview. It is a row action. If a name is needed, the publish flow can
collect or generate it there, close to Create pull request.

## Considered Options

- Keep Auto, Custom, and AI naming in Settings. Rejected. It asks the user to
  solve naming before they know the shape of the work.
- Keep the inline Create branch form in the Overview. Rejected. It makes branch
  naming look like a standing maintenance task instead of a publish step.
- Require a user-facing branch at thread creation. Rejected. It preserves Git's
  mechanics in the UI instead of hiding them behind the worktree abstraction.

## Consequences

- `worktree.naming.mode` and `worktree.naming.aiConfirmation` should be removed
  from user-facing settings and treated as legacy data during migration.
- New worktree creation still needs an internal branch generator. That generator
  remains, but it is not configurable by the user.
- The Overview should align with the Codex Environment menu: Changes, working
  location, current branch, Create branch, Commit or push, Create pull request,
  and Sources.
- Create pull request should depend on a publishable branch. If the current
  checkout still uses only the internal branch, the PR flow should route through
  Create branch first.
- Tests should cover both states: a thread on an internal checkout branch that
  offers Create branch, and a thread on a publishable branch that can commit,
  push, and create a pull request.
