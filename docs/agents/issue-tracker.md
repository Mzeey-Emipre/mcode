# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues at [Mzeey-Empire/mcode](https://github.com/Mzeey-Empire/mcode). Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Issue relationships and dependencies

When a plan spans an epic and several features, wire the relationships natively. Native links are the source of truth; the epic body carries a human-readable view of them.

- **Type by title prefix + label**: `epic: …` (label `epic`) for the parent, `feat: …` (label `feat`) for vertical slices. Children reference the parent with a `## Parent` section (`#<epic>`) and list blockers under `## Blocked by`.
- **Epic body carries a `## Sequencing` ASCII graph** so the order is readable at a glance: `↓` for sequential, `←→ … - can parallel` for parallel-safe slices, `└──┬──┘` for join points. This mirrors the native links; it does not replace them.
- **Do not put priority / estimate / type in the body** — those are project fields and labels. The body starts with `## Description` (or the skill's template) and the relationship sections.

`gh` has no native command for sub-issues or dependencies, so use the API.

**Get an issue's GraphQL node id:**

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id}}}' \
  -f o=Mzeey-Empire -f r=mcode -F n=<number> --jq '.data.repository.issue.id'
```

**Link a sub-issue to its parent** (needs the `sub_issues` feature header):

```bash
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}' \
  -f p=<parent-node-id> -f c=<child-node-id>
```

**Add a blocked-by dependency** (REST; uses the numeric `.id`, not the issue number):

```bash
BLOCKER_ID=$(gh api repos/Mzeey-Empire/mcode/issues/<blocker-number> --jq '.id')
gh api --method POST repos/Mzeey-Empire/mcode/issues/<blocked-number>/dependencies/blocked_by \
  -F issue_id=$BLOCKER_ID
```

Publish issues in dependency order (blockers first) so the real numbers exist before you reference them. Verify with the response fields `parent_issue_url` (sub-issue set) and `issue_dependencies_summary.blocked_by` (dependency set).

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
