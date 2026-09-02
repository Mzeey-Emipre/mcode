# Issue 765 Agent Brief: Overview Usage Row And Provider Limits

Date: 2026-06-22

## Goal

Implement the Overview Usage row and the missing provider-backed usage limit plumbing needed to make the row useful.

This intentionally expands GitHub issue #765 beyond the original UI-only wording. The implementation should show limit utilization only. Do not show API prices, token costs, session cost, paid overage rows, or billing charges in the Overview row.

## Source Of Truth

- GitHub issue: [#765](https://github.com/Mzeey-Empire/mcode/issues/765)
- Parent PRD: [docs/prd/2026-06-16-thread-overview-epic-2-overview-surface.md](../prd/2026-06-16-thread-overview-epic-2-overview-surface.md)
- Overview design: [docs/specs/2026-06-16-thread-overview-design.md](../specs/2026-06-16-thread-overview-design.md)
- Usage design: [docs/specs/2026-04-14-usage-tracking-design.md](../specs/2026-04-14-usage-tracking-design.md)

## Decision

Treat `ProviderUsageInfo.quotaCategories` as the only data source for the Overview row.

The row should render capped quota categories as percentages. If Claude reports a `5-hour limit`, show that. If Claude reports a `Weekly limit`, show that. If Cursor reports separate API and Auto or Composer percentages, show those. If a provider has no capped quota categories, render `usage unavailable`.

Use `sessionCostUsd`, token costs, `extra_usage`, `chargedCents`, `spendCents`, and provider pricing only outside this Overview row. The existing usage popover can keep richer provider data if it already has it.

## External Research Summary

Provider usage sources differ by product.

| Provider | Official limit model | Mcode state | Implementation decision |
| --- | --- | --- | --- |
| Claude | Claude plans expose five-hour session limits and weekly limits. Claude Code `/usage` shows plan usage bars. | `AnthropicOAuthUsageSource` already maps `five_hour` to `5-hour limit` and `seven_day` to `Weekly limit`. | Reuse the existing Claude usage source. Keep the Overview row limited to capped quota categories. |
| Cursor | Cursor plans include a monthly API usage budget plus separate Auto and Composer usage. The dashboard shows real-time usage and remaining allowance. Enterprise Admin API exposes team usage and spending endpoints. | `CursorProvider` has no `getUsage`. Cursor turn events expose token usage, not account limits. | Add Cursor `getUsage` through a bounded Admin API source when configured. Map API and Auto or Composer percentage fields to quota categories when the API response supplies them. |
| Copilot | Copilot paid plans use monthly GitHub AI Credits. Some org and enterprise reports are exposed through GitHub billing APIs. | `CopilotProvider.getUsage()` already calls `account.getQuota()` and normalizes `quotaSnapshots`. | Reuse the existing Copilot provider categories. The row should display the active limited category. |
| Codex | Codex usage counts toward ChatGPT agentic usage. The Codex dashboard and CLI `/status` show remaining limits. Enterprise and Edu limits are moving from weekly limits to monthly credit limits in 2026. | `CodexProvider` has no `getUsage`. No current Mcode source exposes a machine-readable Codex account limit. | Add Codex `getUsage` only if the CLI or app-server exposes a documented machine-readable status response. Do not scrape dashboard text. If no source exists, return empty categories and document that in the PR. |

Source links:

- GitHub Copilot usage limits: https://docs.github.com/en/copilot/concepts/usage-limits
- GitHub Copilot individual billing: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
- GitHub Copilot org and enterprise billing: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
- GitHub billing usage REST API: https://docs.github.com/en/rest/billing/usage
- Cursor usage limits: https://cursor.com/help/models-and-usage/usage-limits.md
- Cursor Admin API: https://cursor.com/docs/account/teams/admin-api.md
- Cursor API overview: https://cursor.com/docs/api.md
- Cursor spend limits: https://cursor.com/help/account-and-billing/spend-limits.md
- Claude usage and length limits: https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- Claude usage limit best practices: https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- Claude Code costs and `/usage`: https://code.claude.com/docs/en/costs
- Claude Pro limits: https://support.claude.com/en/articles/8325606-what-is-the-pro-plan
- Claude Max limits: https://support.claude.com/en/articles/11049741-what-is-the-max-plan
- OpenAI Codex plan usage: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- OpenAI Codex pricing: https://developers.openai.com/codex/pricing
- OpenAI Codex rate card: https://help.openai.com/en/articles/20001106-codex-rate-card
- OpenAI credits for Codex: https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-freegopluspro
- OpenAI Enterprise and Edu usage limits migration: https://help.openai.com/en/articles/20001001-setting-usage-limits-for-custom-roles-in-chatgpt-enterprise

## Existing Mcode State

- `ProviderUsageInfo` and `QuotaCategory` live in `packages/contracts/src/providers/usage.ts`.
- `usageByProvider` lives on each thread record in `apps/web/src/stores/thread-record.ts`.
- `session.quotaUpdate` merges provider state in `apps/web/src/stores/threadStore.ts`.
- `fetchProviderUsage(threadId, providerId)` merges the `provider.getUsage` RPC result.
- `provider.getUsage` falls back to `{ providerId, quotaCategories: [] }` when the provider lacks `getUsage`.
- Claude and Copilot implement `getUsage`.
- Cursor and Codex do not implement `getUsage`.
- Claude already has tests proving `five_hour` and `seven_day` map to quota categories.
- `SidebarUsagePanel` and `UsagePopover` contain existing quota display logic.
- `ThreadOverview` currently renders Changes, Repository, Local, Branch, Commit or PR, and Sources rows.

## Provider Work

### Claude

Keep the existing `AnthropicOAuthUsageSource` and `ClaudeProvider.getUsage`.

The implementation should verify that `5-hour limit` and `Weekly limit` categories reach `usageByProvider.claude`. The Overview row must ignore Claude `sessionCostUsd` and ignore the existing `Pay-as-you-go` category because this row is only about limits.

### Cursor

Add a Cursor usage source under `apps/server/src/providers/cursor/usage/`.

Use Cursor Admin API only when configured. Store the API key in `MCODE_CURSOR_ADMIN_API_KEY`, not in `settings.json`. Add a non-secret setting such as `provider.cursor.usageEmail` if the implementation needs an email to select the current user from team usage. Follow `docs/guides/settings-schema.md` and update `docs/settings/reference.md` if a setting is added.

Recommended source order:

1. If `MCODE_CURSOR_ADMIN_API_KEY` is missing, return empty quota categories.
2. If `provider.cursor.usageEmail` is missing, return empty quota categories. Do not guess a team member.
3. Call `POST https://api.cursor.com/teams/spend` with `searchTerm`, `page`, and `pageSize`.
4. Parse the response with a schema or explicit allowlist. Use the documented member fields and accept optional percentage fields only when the response supplies them.
5. Map Cursor percentage fields to capped quota categories:
   - `apiPercentUsed` -> `API usage`
   - `autoPercentUsed` -> `Auto and Composer`
   - `totalPercentUsed` -> `Total usage`, only if the two more specific fields are absent
6. Convert each percentage to:
   - `used`: reported percentage
   - `total`: `100`
   - `remainingPercent`: `clamp((100 - used) / 100, 0, 1)`
   - `isUnlimited`: `false`

Do not compute display percentages from `spendCents`, `overallSpendCents`, `chargedCents`, token counts, or model prices. Those fields describe billing or event cost, not the limit bars requested here.

Cursor Admin API is Enterprise-only. If the configured key receives 401, 403, 429, malformed JSON, or a response without percentage fields, return empty categories and log a redacted diagnostic.

### Copilot

Keep `CopilotProvider.getUsage` as the usage source. It already normalizes `account.getQuota().quotaSnapshots`.

The UI should display whatever capped Copilot category has the lowest remaining percentage. Copilot limits are monthly credit limits, not weekly limits.

### Codex

Investigate whether the installed Codex CLI or `codex app-server` exposes a documented machine-readable status payload for account limits.

If it does, add `CodexProvider.getUsage` and map capped limits into `QuotaCategory`. If it only exposes a human dashboard or interactive `/status` text, leave Codex with empty categories. Do not scrape browser pages or terminal prose.

## UI Work

In `apps/web/src/components/chat/ThreadOverview.tsx`, read the active provider's usage:

```ts
const activeProviderId = thread.provider;
const usageInfo = useThreadRecord(thread.id, (r) => r.usageByProvider[activeProviderId]);
```

Add a compact Usage row inside the existing Overview row rhythm, after Branch or Local and before Commit or PR actions.

Rendering rules:

- Filter to capped categories: `!category.isUnlimited`.
- Use `1 - remainingPercent` as the display percentage when `used` and `total` are unavailable.
- Prefer category labels over provider-specific prose.
- Show multiple relevant categories when space allows, for example `5-hour 42%, weekly 18%` or `API 63%, Auto 21%`.
- If there is one category, show `Label 42%`.
- If no capped category or provider-proven API-key session cost exists, hide the Usage row.
- Do not render dollar amounts from quota categories in this row.
- Add `data-testid="thread-overview-usage"`.

## Security Requirements

- Keep Cursor API keys in environment variables only.
- Protect `MCODE_CURSOR_ADMIN_API_KEY` from child process environment overrides.
- Never log API keys, Authorization headers, raw API responses, or user email with a failure stack.
- Bound network calls with a timeout.
- Cache Cursor usage responses for at least 15 minutes. Do not poll faster than Cursor API guidance allows.
- Validate external API responses at the boundary.
- Treat all missing or malformed provider data as unavailable, not as zero usage.

## Non-Goals

- No pricing display from quota categories in the Overview row.
- No token cost display in the Overview row.
- No paid overage display in the Overview row.
- No dashboard scraping.
- No browser automation to read provider dashboards.
- No database migration unless a new persisted setting needs one.
- No change to thread turn token accounting.

## Acceptance Criteria

- Claude shows `5-hour limit` when that category exists.
- Claude shows `Weekly limit` when that category exists.
- Cursor shows API usage percentage when the configured Admin API response supplies it.
- Cursor shows Auto or Composer usage percentage when the configured Admin API response supplies it.
- Copilot shows a normalized quota category from existing `quotaSnapshots`.
- Codex shows a quota category only when a supported machine-readable source exists.
- Empty provider usage hides the Overview Usage row.
- The Overview row reads the active provider from `thread.provider`.
- Switching providers reads a different `usageByProvider` entry.
- Opening the Overview does not start an unbounded poll or duplicate fetch loop.
- The PR description states that the change implements the Overview row and provider-backed usage limits together.

## Tests

Add focused tests that can fail for real regressions.

Backend:

- Keep or extend Claude tests that map `five_hour` and `seven_day`.
- Add Cursor usage-source tests for:
  - missing `MCODE_CURSOR_ADMIN_API_KEY`
  - missing configured email
  - `apiPercentUsed` and `autoPercentUsed` mapping
  - `totalPercentUsed` fallback
  - 401, 403, 429, timeout, malformed response
  - no API key or Authorization header in logs
- Add provider tests proving `CursorProvider.getUsage()` returns `ProviderUsageInfo`.

Frontend:

- Add `ThreadOverview` or `HeaderActions` coverage for:
  - single quota category
  - Claude 5-hour plus weekly categories
  - Cursor API plus Auto categories
  - empty usage state
  - active provider switch
  - cost fields ignored unless provider-owned billing mode proves API-key usage

## Verification

For implementation work, verify in this order:

1. Start the app with `bun run dev:web` and open it with browser use.
2. Seed or use a thread with Claude categories and observe `5-hour` or `weekly` usage in Overview.
3. Seed or use a thread with Cursor percentage categories and observe API and Auto usage in Overview.
4. Confirm dollar amounts render only for provider-proven API-key session cost.
5. Confirm no browser console errors.
6. Run focused tests and typecheck.
7. Run focused Vitest or Testing Library coverage for the changed behavior.

## PR Body Note

Use this language in the PR body after implementation:

> Implements the Overview Usage row and the provider-backed usage limit sources together. The row renders capped limit utilization: Claude five-hour and weekly limits, Cursor API and Auto or Composer percentages when the Admin API supplies them, and existing Copilot quota snapshots. It excludes API prices, token costs, paid overage, and dashboard scraping.

If Codex has no supported machine-readable usage source, add:

> Codex hides the Overview Usage row until the provider has a documented machine-readable account-limit or API-key session-cost source.

## Implementation Prompt

Implement GitHub issue #765 in this worktree with the revised scope in this brief. Add the Overview Usage row and provider-backed usage limit plumbing. Reuse Claude and Copilot usage sources. Add Cursor usage limits through a bounded, configured Admin API source. Investigate Codex and add `getUsage` only if a supported machine-readable source exists. Render capped usage-limit percentages, plus provider-proven API-key session cost when available. Do not render prices, token costs, paid overage, or scraped dashboard data. Add focused backend and frontend tests, then run live verification and typecheck.
