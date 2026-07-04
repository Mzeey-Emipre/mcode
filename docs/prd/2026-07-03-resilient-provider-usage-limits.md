# Resilient Provider Usage Limits

Draft status: review before issue publication

## Problem Statement

Developers rely on usage limits to decide whether to keep working in the current provider or switch before a limit blocks them. The display can lose quota data when a provider check returns an empty or failed result, and it does not show reset timing next to each limit.

This is confusing when two machines show different Codex usage. The user cannot tell whether the provider returned no quota, the check failed, the account differs, or refresh cleared known data.

The user also needs reset timing per limit. Five-hour and weekly limits reset at different times, so one provider-level reset label is not enough.

## Solution

Make provider usage a resilient provider-scoped snapshot. A successful snapshot can contain quota categories, billing mode, reset dates, and freshness metadata. Thread-scoped cost stays separate. Failed refresh must not replace known-good quota with empty data.

Show reset information below each capped quota progress bar when the provider reports a reset date. The reset line should be category-specific, for example `Resets in 2h 14m · Jul 3, 14:10`.

Apply the behavior to Claude, Codex, and Copilot where reset data exists. Claude and Codex expose reset dates for known windows. Copilot snapshots include reset dates when supplied. Leave Cursor out until Mcode has a current-user quota source.

## User Stories

1. As a developer using Codex, I want the five-hour usage bar to show when it resets, so that I can decide whether to wait or switch providers.
2. As a developer using Codex, I want the weekly usage bar to show its own reset time, so that I do not confuse it with five-hour usage.
3. As a developer using Claude, I want five-hour and weekly limits to show reset timing below their own bars, so that I can see which limit recovers first.
4. As a developer using Copilot, I want quota snapshots with reset dates to show those dates, so that Copilot follows the same display rule.
5. As a Cursor user, I want no usage-limit row until Mcode has a current-user source, so that team/admin data is not mistaken for my quota.
6. As a developer comparing two machines, I want Mcode to preserve the last known good snapshot when refresh fails, so that a local check miss does not look like a quota change.
7. As a developer, I want Mcode to distinguish unavailable usage from empty quota categories, so that the UI can explain state without wiping data.
8. As a developer, I want failed refreshes to mark usage as stale and successful refreshes to clear stale state, so that recovery is visible.
9. As a developer, I want Overview to stay compact, so that reset text adds information without becoming a dashboard.
10. As a keyboard or screen-reader user, I want each progress bar to expose its percentage and reset text, so that visual information is available.
11. As a developer, I want no reset text when a reset date is missing, invalid, or unusable, so that the UI avoids placeholders.
12. As a maintainer, I want provider-specific usage rules inside provider adapters, so that the UI consumes one usage snapshot Interface.

## Data Ownership

Quota categories are provider/account-scoped. Codex, Claude, and Copilot quota belongs to the signed-in account, not one thread. A successful quota refresh should be reusable by every thread using that account.

Session cost, service tier, turns, duration, context, and last-turn tokens are thread-scoped. Provider quota refresh must not overwrite them unless the provider response reports thread data.

The usage snapshot Interface should keep these ownership rules visible. Provider quota and thread metrics can share a display surface, but their refresh and stale rules differ.

## Usage State Model

| State | Trigger | Retained data | Overview | Usage popover | Recovery |
| --- | --- | --- | --- | --- | --- |
| `ready` | Provider returns valid quota categories or session usage. | Latest data and `fetchedAt`. | Show usage and reset lines. | Show categories, reset lines, last updated time. | Next successful refresh replaces it. |
| `ready-empty` | Provider supports usage but has no capped categories. | Empty snapshot and `fetchedAt`. | Hide usage row. | `No capped quota reported`. | Later categories replace it. |
| `stale` | Refresh fails after `ready`. | Last known good data, `fetchedAt`, failed time, redacted reason. | Show usage with stale indication in details. | `Could not refresh. Showing last update from X`. | Success returns to `ready`; expiry moves to `unavailable`. |
| `unavailable` | Refresh fails without known-good data, auth/config is missing, or payload is malformed. | Redacted reason and failed time. | Hide usage row. | `Usage unavailable`. | Success returns to `ready` or `ready-empty`. |
| `unsupported` | Provider has no usage source. | Provider id and reason. | Hide usage row. | `Usage not supported for this provider`. | Requires provider implementation change. |

Last-known-good quota remains actionable for the current app session for up to 24 hours. After that, stale usage becomes unavailable until refresh succeeds. Overview should not show exact diagnostics. Usage popover can show a redacted reason; server logs can hold details.

## Implementation Decisions

- Keep `ProviderUsageInfo` as the successful usage payload, including `quotaCategories` and each category's optional `resetDate`.
- Add provider usage snapshot state around successful usage data. It must distinguish ready, stale, unavailable, and unsupported usage.
- Preserve last known good usage per provider. Failed refresh, malformed payload, timeout, or unavailable provider must not overwrite it.
- Treat explicit empty categories as ready only when the provider source can prove that no capped quotas exist.
- Keep provider-specific mapping in each provider adapter or usage source. The UI should not know Codex window names, Claude OAuth fields, or Copilot quota fields.
- Display reset text below each Overview progress bar for categories with a valid future reset date.
- Use a shared reset formatter for Overview and Usage popover. It should return relative text and compact exact date/time.
- Hide reset text when `resetDate` is missing, invalid, or cannot be trusted.
- Keep the five-hour category above the weekly category, regardless of provider return order.
- Keep Overview limited to capped quota categories and provider-proven API-key session cost. Do not show token prices, paid overage, or dashboard billing rows.
- For Claude, retain current five-hour and weekly mapping, then inspect the current usage response for the recent shape the user called out.
- For Codex, keep using machine-readable app-server rate-limit data and reset timestamps.
- For Copilot, keep using normalized quota snapshots and any SDK-supplied `resetDate`.
- Leave Cursor out of this usage-limit surface. Existing Cursor team/admin usage sources must not feed Overview usage limits unless they become a current-user quota source.
- Add safe diagnostics for usage-source failures: provider id, source kind, CLI path or version, last refresh time, and redacted reason. Exclude secrets, tokens, Authorization headers, raw responses, and email.
- Surface diagnostics in Usage popover and server logs only. Overview should show at most a stale indication when expanded.

## Testing Decisions

- Test through the highest useful Interface: provider usage snapshot fetch, thread usage merge, and Overview rendering.
- Add shared formatter tests for `Resets in X`, exact date/time output, expired, invalid, and missing timestamps.
- Add provider tests proving Claude, Codex, and Copilot reset dates reach quota categories when supplied.
- Add Cursor tests proving no usage-limit row appears while Cursor remains unsupported for current-user quota.
- Add store tests proving failed or empty refreshes do not erase a known-good snapshot.
- Add Overview and Usage popover tests for per-category reset text, including five-hour, weekly, and Copilot categories.
- Add accessibility assertions for progress bars and reset descriptions.
- Live verification: run the app, open a seeded quota thread, confirm reset lines, simulate refresh failure, and confirm previous data remains visible as stale.
- Run focused web tests around Overview, then run the repo verification gate before claiming completion.

## Out of Scope

- Scraping provider dashboards.
- Estimating quota from local token counts.
- Showing provider pricing, paid overage, token costs, or billing charges in the Overview row.
- Showing Cursor usage limits from team/admin APIs.
- Persisting usage history across app restarts.
- Changing provider plan rules or local account authentication.
- Long-term modeling of provider plan migrations beyond fields exposed by current machine-readable sources.

## Further Notes

Current code carries `resetDate` on quota categories. Codex, Claude, and Copilot carry reset dates through provider categories. Cursor has team/admin usage plumbing, but this PRD excludes it as a current-user quota source.

The store preserves existing categories for quota update events with empty categories, but direct provider usage fetch can still replace usage with an empty response. That is the first resilience gap.

Open validation questions:

1. Is 24 hours the right stale-data expiry for the current app session?
2. Should the exact reset date and time always be inline below the bar, or should Overview show relative text inline and the exact timestamp in a tooltip?
3. For Claude's changed usage payload, should discovery happen before code changes, or inside the same implementation issue?
